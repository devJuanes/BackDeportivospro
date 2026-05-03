/**
 * Cierra automáticamente picks pendientes (won/lost) usando marcadores en caché + SoccersAPI.
 */
const logger = require("../utils/logger");
const { db } = require("../config/database");
const { getFixturesByDateSport } = require("../models/fixtureModel");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
const { formatDateInTimezone } = require("../utils/helpers");

function teamsLikelyMatch(a, b) {
  const x = String(a || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const y = String(b || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const wx = x.split(/\s+/).filter((w) => w.length > 3);
  const wy = y.split(/\s+/).filter((w) => w.length > 3);
  return wx.some((xi) => wy.some((yi) => xi === yi));
}

function mergePairKey(ta, tb) {
  const x = String(ta || "").toLowerCase();
  const y = String(tb || "").toLowerCase();
  return x <= y ? `${x}|${y}` : `${y}|${x}`;
}

function findFixtureRow(fixtures, homePick, awayPick) {
  for (const f of fixtures) {
    const fa = f.team_a;
    const fb = f.team_b;
    if (
      (teamsLikelyMatch(fa, homePick) && teamsLikelyMatch(fb, awayPick)) ||
      (teamsLikelyMatch(fa, awayPick) && teamsLikelyMatch(fb, homePick))
    ) {
      return f;
    }
  }
  return null;
}

async function loadFinishedResultsForDate(dateIso) {
  const byPair = new Map();
  let dbRows = [];
  try {
    dbRows = await getFixturesByDateSport(dateIso, "football");
  } catch (error) {
    logger.warn(`Settlement fixtures_cache ${dateIso}: ${error.message}`);
  }

  const put = (ta, tb, hg, ag, source) => {
    const k = mergePairKey(ta, tb);
    byPair.set(k, {
      team_a: ta,
      team_b: tb,
      home_goals: hg,
      away_goals: ag,
      source,
    });
  };

  for (const f of dbRows) {
    if (String(f.status || "").toLowerCase() !== "post") continue;
    put(f.team_a, f.team_b, Number(f.home_goals) || 0, Number(f.away_goals) || 0, "cache");
  }

  try {
    const { isConfigured, getSoccersFootballFixturesForDate } = require("./soccersApiService");
    if (isConfigured()) {
      const soc = await getSoccersFootballFixturesForDate(dateIso);
      for (const s of soc) {
        if (String(s.status || "").toLowerCase() !== "post") continue;
        put(s.homeTeam, s.awayTeam, Number(s.homeGoals) || 0, Number(s.awayGoals) || 0, "soccersapi");
      }
    }
  } catch (error) {
    logger.warn(`Settlement SoccersAPI ${dateIso}: ${error.message}`);
  }

  return [...byPair.values()];
}

async function settleRowsForTable(table, config) {
  const { statusField, homeField, awayField, pickField, hasSport } = config;
  const pendingVal = "pending";

  const selectCols = hasSport
    ? `id, match_date, sport, ${homeField}, ${awayField}, ${pickField}`
    : `id, match_date, ${homeField}, ${awayField}, ${pickField}`;

  const { data: picks, error } = await db.from(table).select(selectCols).eq(statusField, pendingVal).limit(280);

  if (error) {
    logger.warn(`Settlement lectura ${table}: ${error.message}`);
    return { updated: 0 };
  }
  if (!picks?.length) return { updated: 0 };

  const byDate = new Map();
  for (const p of picks) {
    const d = String(p.match_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (hasSport && String(p.sport || "football").toLowerCase() !== "football") continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(p);
  }

  let updated = 0;

  for (const [dateIso, datePicks] of byDate) {
    const results = await loadFinishedResultsForDate(dateIso);
    if (results.length === 0) continue;

    for (const pick of datePicks) {
      const home = pick[homeField];
      const away = pick[awayField];
      const pickText = pick[pickField];
      const fx = findFixtureRow(results, home, away);
      if (!fx) continue;

      const outcome = evaluateFootballPickFromText(pickText, fx.home_goals, fx.away_goals, home, away);
      if (!outcome) continue;

      const patch = { [statusField]: outcome, updated_at: new Date().toISOString() };
      const u = await db.from(table).eq("id", pick.id).update(patch);
      if (u.error) {
        logger.warn(`Settlement update ${table} ${pick.id}: ${u.error.message}`);
        continue;
      }
      updated += 1;
    }
  }

  return { updated };
}

/**
 * Una pasada de liquidación para free_picks, vip_picks, abet, abetvip.
 */
async function settlePendingPickResultsOnce() {
  if (String(process.env.FACTORY_AUTO_SETTLE_ENABLED || "true").toLowerCase() === "false") {
    return { skipped: true };
  }

  const configs = [
    {
      table: process.env.FACTORY_FREE_TABLE || "free_picks",
      statusField: "status",
      homeField: "team_a",
      awayField: "team_b",
      pickField: "pick_text",
      hasSport: true,
    },
    {
      table: process.env.FACTORY_VIP_TABLE || "vip_picks",
      statusField: "status",
      homeField: "team_a",
      awayField: "team_b",
      pickField: "pick_text",
      hasSport: true,
    },
    {
      table: "abet",
      statusField: "state",
      homeField: "home_team_name",
      awayField: "away_team_name",
      pickField: "prediction",
      hasSport: false,
    },
    {
      table: "abetvip",
      statusField: "state",
      homeField: "home_team_name",
      awayField: "away_team_name",
      pickField: "prediction",
      hasSport: false,
    },
  ];

  let total = 0;
  for (const c of configs) {
    try {
      const r = await settleRowsForTable(c.table, c);
      total += r.updated || 0;
    } catch (error) {
      logger.warn(`Settlement tabla ${c.table}: ${error.message}`);
    }
  }

  if (total > 0) {
    logger.info(`[Settlement] picks actualizados: ${total}`);
  }
  return { updated: total, today: formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota") };
}

module.exports = {
  settlePendingPickResultsOnce,
};
