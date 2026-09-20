/**
 * Cierra automáticamente picks pendientes (won/lost) y sincroniza marcador real.
 * Usa fixtures en vivo + finalizados (caché ESPN + SoccersAPI).
 */
const logger = require("../utils/logger");
const { db } = require("../config/database");
const { getFixturesByDateSport } = require("../models/fixtureModel");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
const { formatDateInTimezone } = require("../utils/helpers");
const { normalizeTeamToken } = require("../utils/predictionDedupe");

const FINISHED = new Set(["post", "final", "ft", "finished", "ended", "complete", "completed"]);
const LIVE = new Set(["in", "live", "halftime", "ht", "1h", "2h"]);

function teamsLikelyMatch(a, b) {
  const x = normalizeTeamToken(a);
  const y = normalizeTeamToken(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x))) return true;
  const wx = x.split(/\s+/).filter((w) => w.length > 3);
  const wy = y.split(/\s+/).filter((w) => w.length > 3);
  if (wx.length === 0 || wy.length === 0) return false;
  const overlap = wx.filter((xi) => wy.some((yi) => xi === yi || xi.includes(yi) || yi.includes(xi)));
  return overlap.length >= Math.min(2, wx.length, wy.length) || (overlap.length >= 1 && Math.min(x.length, y.length) <= 10);
}

function mergePairKey(ta, tb) {
  const x = normalizeTeamToken(ta);
  const y = normalizeTeamToken(tb);
  return x <= y ? `${x}|${y}` : `${y}|${x}`;
}

function findFixtureRow(fixtures, homePick, awayPick) {
  let best = null;
  let bestScore = 0;
  for (const f of fixtures) {
    const fa = f.team_a;
    const fb = f.team_b;
    const direct =
      teamsLikelyMatch(fa, homePick) && teamsLikelyMatch(fb, awayPick);
    const swapped =
      teamsLikelyMatch(fa, awayPick) && teamsLikelyMatch(fb, homePick);
    if (!direct && !swapped) continue;
    const exact =
      (normalizeTeamToken(fa) === normalizeTeamToken(homePick) &&
        normalizeTeamToken(fb) === normalizeTeamToken(awayPick)) ||
      (normalizeTeamToken(fa) === normalizeTeamToken(awayPick) &&
        normalizeTeamToken(fb) === normalizeTeamToken(homePick));
    const score = exact ? 3 : direct || swapped ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = { ...f, _swapped: swapped && !direct };
    }
  }
  return best;
}

function goalsFromFixture(fx) {
  let hg = Number(fx.home_goals) || 0;
  let ag = Number(fx.away_goals) || 0;
  if (fx._swapped) {
    const tmp = hg;
    hg = ag;
    ag = tmp;
  }
  return { hg, ag };
}

function isFinishedStatus(status) {
  return FINISHED.has(String(status || "").toLowerCase());
}

function isLiveStatus(status) {
  const s = String(status || "").toLowerCase();
  return LIVE.has(s) || Number.isFinite(Number(status));
}

/** Fixtures del día: live + finalizados (para early settle + marcador). */
async function loadResultsForDate(dateIso) {
  const byPair = new Map();
  let dbRows = [];
  try {
    dbRows = await getFixturesByDateSport(dateIso, "football");
  } catch (error) {
    logger.warn(`Settlement fixtures_cache ${dateIso}: ${error.message}`);
  }

  const put = (ta, tb, hg, ag, status, minute, source) => {
    const k = mergePairKey(ta, tb);
    const prev = byPair.get(k);
    const finished = isFinishedStatus(status);
    const live = isLiveStatus(status);
    if (!finished && !live && !(Number(hg) + Number(ag) > 0)) return;
    // Preferir final > live; si mismo estado, el de más goles / minuto.
    const rank = finished ? 3 : live ? 2 : 1;
    const prevRank = prev ? (isFinishedStatus(prev.status) ? 3 : isLiveStatus(prev.status) ? 2 : 1) : 0;
    if (prev && prevRank > rank) return;
    if (prev && prevRank === rank) {
      const prevTotal = (prev.home_goals || 0) + (prev.away_goals || 0);
      const nextTotal = (Number(hg) || 0) + (Number(ag) || 0);
      if (nextTotal < prevTotal) return;
    }
    byPair.set(k, {
      team_a: ta,
      team_b: tb,
      home_goals: Number(hg) || 0,
      away_goals: Number(ag) || 0,
      status: status || "pre",
      minute: Number(minute) || 0,
      source,
    });
  };

  for (const f of dbRows) {
    put(f.team_a, f.team_b, f.home_goals, f.away_goals, f.status, f.minute, "cache");
  }

  try {
    const { isConfigured, getSoccersFootballFixturesForDate } = require("./soccersApiService");
    if (isConfigured()) {
      const soc = await getSoccersFootballFixturesForDate(dateIso);
      for (const s of soc) {
        put(s.homeTeam, s.awayTeam, s.homeGoals, s.awayGoals, s.status, s.minute, "soccersapi");
      }
    }
  } catch (error) {
    logger.warn(`Settlement SoccersAPI ${dateIso}: ${error.message}`);
  }

  return [...byPair.values()];
}

async function applyPickPatch(table, pickId, patch) {
  let u = await db.from(table).eq("id", pickId).update(patch);
  if (u.error) {
    const msg = String(u.error.message || "").toLowerCase();
    if (msg.includes("home_goals") || msg.includes("minute") || msg.includes("column") || msg.includes("live_ended")) {
      const slim = { updated_at: patch.updated_at };
      if (patch.state != null || patch.status != null) {
        if (patch.state != null) slim.state = patch.state;
        if (patch.status != null) slim.status = patch.status;
      }
      // statusField generic
      for (const k of Object.keys(patch)) {
        if (["home_goals", "away_goals", "minute", "live_ended"].includes(k)) continue;
        if (slim[k] === undefined) slim[k] = patch[k];
      }
      delete slim.home_goals;
      delete slim.away_goals;
      delete slim.minute;
      delete slim.live_ended;
      u = await db.from(table).eq("id", pickId).update(slim);
    }
  }
  return u;
}

async function settleRowsForTable(table, config) {
  const { statusField, homeField, awayField, pickField, hasSport, isLiveTable } = config;

  const selectCols = hasSport
    ? `id, match_date, sport, ${homeField}, ${awayField}, ${pickField}, ${statusField}, home_goals, away_goals, minute, live_ended, outcome`
    : `id, match_date, ${homeField}, ${awayField}, ${pickField}, ${statusField}, home_goals, away_goals, minute`;

  let picks = [];
  let { data, error } = await db.from(table).select(selectCols).limit(500);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("home_goals") || msg.includes("live_ended") || msg.includes("column")) {
      const slimCols = hasSport
        ? `id, match_date, sport, ${homeField}, ${awayField}, ${pickField}, ${statusField}, home_goals, away_goals, minute`
        : `id, match_date, ${homeField}, ${awayField}, ${pickField}, ${statusField}, home_goals, away_goals, minute`;
      const retry = await db.from(table).select(slimCols).limit(500);
      if (retry.error) {
        const slim2 = hasSport
          ? `id, match_date, sport, ${homeField}, ${awayField}, ${pickField}, ${statusField}`
          : `id, match_date, ${homeField}, ${awayField}, ${pickField}, ${statusField}`;
        const retry2 = await db.from(table).select(slim2).limit(500);
        data = retry2.data;
        error = retry2.error;
      } else {
        data = retry.data;
        error = null;
      }
    }
  }
  if (error) {
    const msg = String(error.message || "");
    if (!msg.includes("does not exist") && !msg.toLowerCase().includes("fetch failed")) {
      logger.warn(`Settlement lectura ${table}: ${msg}`);
    }
    return { updated: 0, scored: 0 };
  }

  picks = (data || []).filter((p) => {
    const st = String(p[statusField] || "pending").toLowerCase();
    const hg = Number(p.home_goals) || 0;
    const ag = Number(p.away_goals) || 0;
    if (isLiveTable) {
      if (p.live_ended === true && (st === "won" || st === "lost")) return false;
      return st === "live" || st === "pending" || st === "won" || st === "lost" || !st;
    }
    if (st === "pending" || st === "live") return true;
    if ((st === "won" || st === "lost" || st === "ganada" || st === "perdida") && hg === 0 && ag === 0) {
      return true;
    }
    return false;
  });

  if (!picks.length) return { updated: 0, scored: 0 };

  const byDate = new Map();
  const noDate = [];
  for (const p of picks) {
    if (hasSport) {
      const sp = String(p.sport || "football").toLowerCase();
      if (sp && sp !== "football" && sp !== "soccer") continue;
    }
    const d = String(p.match_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      noDate.push(p);
      continue;
    }
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(p);
  }

  let updated = 0;
  let scored = 0;

  async function processPick(pick, fx) {
    const home = pick[homeField];
    const away = pick[awayField];
    const pickText = pick[pickField];
    const prevState = String(pick[statusField] || "pending").toLowerCase();

    let hg = Number(pick.home_goals) || 0;
    let ag = Number(pick.away_goals) || 0;
    let minute = Number(pick.minute) || 0;
    let finished = false;

    if (fx) {
      const g = goalsFromFixture(fx);
      // Preferir marcador de fixture si trae más info / partido más avanzado.
      const fxTotal = g.hg + g.ag;
      const selfTotal = hg + ag;
      if (fxTotal >= selfTotal) {
        hg = g.hg;
        ag = g.ag;
      }
      minute = Math.max(minute, Number(fx.minute) || 0);
      finished = isFinishedStatus(fx.status);
    }

    // 1) Early settle con marcador propio o de fixture (NO esperar FT en overs/BTTS).
    const outcome = evaluateFootballPickFromText(pickText, hg, ag, home, away, {
      matchFinished: finished,
    });

    const patch = { updated_at: new Date().toISOString() };
    if (hg > 0 || ag > 0 || minute > 0 || fx) {
      patch.home_goals = hg;
      patch.away_goals = ag;
      if (minute > 0) patch.minute = minute;
    }

    if (outcome === "won" || outcome === "lost" || outcome === "void") {
      patch[statusField] = outcome;
      if (isLiveTable) {
        patch.outcome = outcome;
        if (finished) patch.live_ended = true;
      }
    } else if (isLiveTable && finished) {
      patch[statusField] = prevState === "won" || prevState === "lost" ? prevState : "pending";
      patch.live_ended = true;
      if (prevState === "won" || prevState === "lost") patch.outcome = prevState;
    } else if (isLiveTable && (minute > 0 || hg + ag > 0) && prevState !== "won" && prevState !== "lost") {
      patch[statusField] = "live";
    }

    if (Object.keys(patch).length <= 1) return;

    const u = await applyPickPatch(table, pick.id, patch);
    if (u.error) {
      logger.warn(`Settlement update ${table} ${pick.id}: ${u.error.message}`);
      return;
    }
    scored += 1;
    if (patch[statusField] && patch[statusField] !== prevState) {
      updated += 1;
      if (
        (patch[statusField] === "won" || patch[statusField] === "lost") &&
        prevState !== "won" &&
        prevState !== "lost"
      ) {
        try {
          const { notifyFollowedSettled } = require("./predictionNotifyService");
          await notifyFollowedSettled(
            {
              id: pick.id,
              home_team_name: pick[homeField],
              away_team_name: pick[awayField],
              prediction: pick[pickField],
              home_goals: patch.home_goals ?? pick.home_goals,
              away_goals: patch.away_goals ?? pick.away_goals,
            },
            patch[statusField]
          );
        } catch {
          /* push opcional */
        }
      }
    }
  }

  // Sin fecha: solo self-score.
  for (const pick of noDate) {
    await processPick(pick, null);
  }

  for (const [dateIso, datePicks] of byDate) {
    let results = [];
    try {
      results = await loadResultsForDate(dateIso);
    } catch {
      results = [];
    }
    for (const pick of datePicks) {
      const fx = results.length
        ? findFixtureRow(results, pick[homeField], pick[awayField])
        : null;
      await processPick(pick, fx);
    }
  }

  return { updated, scored };
}

/**
 * Una pasada de liquidación + sync de marcadores (planta + live + cola API).
 */
async function settlePendingPickResultsOnce() {
  if (String(process.env.FACTORY_AUTO_SETTLE_ENABLED || "true").toLowerCase() === "false") {
    return { skipped: true };
  }

  const configs = [
    {
      table: process.env.DP_PREDICTIONS_TABLE || "dp_predictions",
      statusField: "status",
      homeField: "home_team",
      awayField: "away_team",
      pickField: "prediction",
      hasSport: true,
    },
    {
      table: process.env.FACTORY_PROD_FREE_TABLE || "abet",
      statusField: "state",
      homeField: "home_team_name",
      awayField: "away_team_name",
      pickField: "prediction",
      hasSport: true,
    },
    {
      table: process.env.FACTORY_PROD_VIP_TABLE || "abetvip",
      statusField: "state",
      homeField: "home_team_name",
      awayField: "away_team_name",
      pickField: "prediction",
      hasSport: true,
    },
    {
      table: "abetlive",
      statusField: "state",
      homeField: "home_team_name",
      awayField: "away_team_name",
      pickField: "prediction",
      hasSport: true,
      isLiveTable: true,
    },
  ];

  let total = 0;
  let scored = 0;
  for (const c of configs) {
    try {
      const r = await settleRowsForTable(c.table, c);
      total += r.updated || 0;
      scored += r.scored || 0;
    } catch (error) {
      const msg = String(error.message || "");
      if (!msg.includes("does not exist") && !msg.includes("fetch failed")) {
        logger.warn(`Settlement tabla ${c.table}: ${msg}`);
      }
    }
  }

  if (total > 0 || scored > 0) {
    logger.info(`[Settlement] estados=${total} marcadores=${scored}`);
  }
  return {
    updated: total,
    scored,
    today: formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota"),
  };
}

module.exports = {
  settlePendingPickResultsOnce,
  loadResultsForDate,
};
