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
const { isPlausibleScore } = require("../utils/liveScoreMatch");
const { settledFromRow, hardenSettledPatch } = require("../utils/preserveSettledOutcome");

const FINISHED = new Set(["post", "final", "ft", "finished", "ended", "complete", "completed"]);
const LIVE = new Set(["in", "live", "halftime", "ht", "1h", "2h"]);

function teamsLikelyMatch(a, b) {
  const x = normalizeTeamToken(a);
  const y = normalizeTeamToken(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Evitar matches flojos (ej. "M" / "Sun") que mezclan marcadores entre partidos.
  if (x.length < 6 || y.length < 6) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const wx = x.split(/\s+/).filter((w) => w.length > 3);
  const wy = y.split(/\s+/).filter((w) => w.length > 3);
  if (wx.length === 0 || wy.length === 0) return false;
  const overlap = wx.filter((xi) => wy.some((yi) => xi === yi || xi.includes(yi) || yi.includes(xi)));
  return overlap.length >= Math.min(2, wx.length, wy.length);
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
async function loadResultsForDate(dateIso, sport = "football") {
  const byPair = new Map();
  let dbRows = [];
  const sportKey = String(sport || "football").toLowerCase() || "football";
  try {
    dbRows = await getFixturesByDateSport(dateIso, sportKey);
  } catch (error) {
    logger.warn(`Settlement fixtures_cache ${dateIso}/${sportKey}: ${error.message}`);
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

  if (sportKey === "football" || sportKey === "soccer") {
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
  }

  return [...byPair.values()];
}

async function applyPickPatch(table, pickId, patch) {
  // Blindaje: nunca degradar won/lost → pending/live.
  try {
    const { data } = await db
      .from(table)
      .select("id,state,status,outcome")
      .eq("id", pickId)
      .limit(1);
    const cur = Array.isArray(data) ? data[0] : data;
    if (cur) {
      hardenSettledPatch(cur, patch, {
        liveTable: table === "abetlive" || String(table).includes("live"),
      });
    }
  } catch {
    /* si no se puede leer, igual intentar update */
  }

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

  const tz = process.env.FACTORY_TIMEZONE || "America/Bogota";
  const today = formatDateInTimezone(new Date(), tz);
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 2);
  const since = formatDateInTimezone(yesterdayDate, tz);

  let picks = [];
  // Solo días recientes: evita que 500 pending viejos bloqueen la liquidación de hoy.
  let query = db
    .from(table)
    .select(selectCols)
    .gte("match_date", since)
    .lte("match_date", today)
    .limit(800);
  let { data, error } = await query;
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("home_goals") || msg.includes("live_ended") || msg.includes("column")) {
      const slimCols = hasSport
        ? `id, match_date, sport, ${homeField}, ${awayField}, ${pickField}, ${statusField}, home_goals, away_goals, minute`
        : `id, match_date, ${homeField}, ${awayField}, ${pickField}, ${statusField}, home_goals, away_goals, minute`;
      const retry = await db
        .from(table)
        .select(slimCols)
        .gte("match_date", since)
        .lte("match_date", today)
        .limit(800);
      if (retry.error) {
        const slim2 = hasSport
          ? `id, match_date, sport, ${homeField}, ${awayField}, ${pickField}, ${statusField}`
          : `id, match_date, ${homeField}, ${awayField}, ${pickField}, ${statusField}`;
        const retry2 = await db
          .from(table)
          .select(slim2)
          .gte("match_date", since)
          .lte("match_date", today)
          .limit(800);
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
    const oc = String(p.outcome || "").toLowerCase();
    const hg = Number(p.home_goals) || 0;
    const ag = Number(p.away_goals) || 0;
    if (isLiveTable) {
      // Ya liquidado (ended + outcome won/lost): no tocar.
      if (["won", "lost", "void"].includes(oc) && (st === "ended" || p.live_ended === true)) {
        return false;
      }
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

  // Agrupar por fecha + deporte para cargar fixtures correctos (fútbol/NBA/tenis/hockey).
  const byDateSport = new Map();
  const noDate = [];
  for (const p of picks) {
    const d = String(p.match_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      noDate.push(p);
      continue;
    }
    let sp = hasSport
      ? String(p.sport || "football").toLowerCase() || "football"
      : "football";
    if (sp === "soccer") sp = "football";
    const key = `${d}|${sp}`;
    if (!byDateSport.has(key)) byDateSport.set(key, { date: d, sport: sp, picks: [] });
    byDateSport.get(key).picks.push(p);
  }

  let updated = 0;
  let scored = 0;

  async function processPick(pick, fx) {
    const home = pick[homeField];
    const away = pick[awayField];
    const pickText = pick[pickField];
    const prevState = String(pick[statusField] || "pending").toLowerCase();
    const locked = settledFromRow(pick);

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

    const sport = String(pick.sport || "football").toLowerCase();
    if (!isPlausibleScore(sport, hg, ag, minute)) {
      // Limpiar marcador inventado/cruzado; conservar estado won/lost si ya existe.
      if (hg || ag || minute) {
        const clear = {
          updated_at: new Date().toISOString(),
          home_goals: 0,
          away_goals: 0,
          minute: 0,
        };
        if (locked) {
          if (isLiveTable) {
            clear.state = "ended";
            clear.outcome = locked;
            clear.live_ended = true;
          } else {
            clear[statusField] = locked;
          }
        }
        await applyPickPatch(table, pick.id, clear);
        scored += 1;
      }
      return;
    }

    // Tips ya liquidados: solo sync marcador, NUNCA bajar a pending/live.
    if (locked || prevState === "won" || prevState === "lost" || prevState === "void" || prevState === "ganada" || prevState === "perdida") {
      const result = locked || (prevState === "ganada" ? "won" : prevState === "perdida" ? "lost" : prevState);
      const patch = { updated_at: new Date().toISOString() };
      if (hg > 0 || ag > 0 || minute > 0 || fx) {
        patch.home_goals = hg;
        patch.away_goals = ag;
        if (minute > 0) patch.minute = minute;
      }
      if (isLiveTable) {
        patch.state = "ended";
        patch.outcome = result;
        patch.live_ended = true;
      } else {
        patch[statusField] = result;
      }
      if (Object.keys(patch).length <= 1) return;
      const u = await applyPickPatch(table, pick.id, patch);
      if (!u.error) scored += 1;
      return;
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
      if (isLiveTable) {
        patch.state = "ended";
        patch.outcome = outcome;
        patch.live_ended = true;
      } else {
        patch[statusField] = outcome;
        // También outcome para front/MatuDB (mapAbetRow lo lee).
        patch.outcome = outcome;
      }
    } else if (isLiveTable && finished) {
      // Partido terminó: intentar outcome; pending SOLO si no hay resultado previo ni evaluable.
      patch.state = "ended";
      patch.live_ended = true;
      if (!locked) patch.outcome = "pending";
    } else if (isLiveTable && (minute > 0 || hg + ag > 0)) {
      patch[statusField] = "live";
    }

    if (Object.keys(patch).length <= 1) return;

    // Blindaje: si el tip ya tenía won/lost, no degradar.
    hardenSettledPatch(pick, patch, { liveTable: isLiveTable });
    if (isLiveTable && locked && patch.outcome && !["won", "lost", "void"].includes(String(patch.outcome).toLowerCase())) {
      patch.outcome = locked;
      patch.state = "ended";
    }

    const u = await applyPickPatch(table, pick.id, patch);
    if (u.error) {
      logger.warn(`Settlement update ${table} ${pick.id}: ${u.error.message}`);
      return;
    }
    scored += 1;
    const settledNow = isLiveTable ? patch.outcome : patch[statusField];
    if (settledNow && settledNow !== prevState && (settledNow === "won" || settledNow === "lost")) {
      updated += 1;
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
          settledNow
        );
      } catch {
        /* push opcional */
      }
    }
  }

  // Sin fecha: solo self-score.
  for (const pick of noDate) {
    await processPick(pick, null);
  }

  for (const { date: dateIso, sport, picks: datePicks } of byDateSport.values()) {
    let results = [];
    try {
      results = await loadResultsForDate(dateIso, sport);
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
  const { isAutoSettleEnabled } = require("./factoryService");
  if (!isAutoSettleEnabled()) {
    return { skipped: true, reason: "auto_settle_disabled" };
  }
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
