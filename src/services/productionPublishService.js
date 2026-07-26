const { db } = require("../config/database");
const { normalizeMatchHour } = require("../utils/matchHour");
const {
  normalizePickLabel,
  normalizeTeamToken,
  fixtureTierDedupeKey,
} = require("../utils/predictionDedupe");
const { getFreePredictions } = require("../models/predictionModel");
const { getVipPredictions } = require("../models/vipModel");
const { formatDateInTimezone } = require("../utils/helpers");
const logger = require("../utils/logger");

const FREE_PROD = process.env.FACTORY_PROD_FREE_TABLE || "abet";
const VIP_PROD = process.env.FACTORY_PROD_VIP_TABLE || "abetvip";

function isAutoPublishEnabled() {
  return String(process.env.FACTORY_AUTO_PUBLISH || "true").toLowerCase() !== "false";
}

function todayIsoDate() {
  return formatDateInTimezone(
    new Date(),
    process.env.FACTORY_TIMEZONE || "America/Bogota"
  );
}

function mapPickToProductionRow(pick) {
  const home =
    pick.homeTeam?.name || pick.home_team_name || pick.team_a || "";
  const away =
    pick.awayTeam?.name || pick.away_team_name || pick.team_b || "";
  const matchDate = String(pick.date || pick.match_date || "").slice(0, 10);
  const matchHour = normalizeMatchHour(pick.hours || pick.match_hour);
  const prediction = String(pick.prediction || pick.pick_text || "").trim();
  const homeLogo = pick.homeTeam?.logo || pick.home_team_logo || "";
  const awayLogo = pick.awayTeam?.logo || pick.away_team_logo || "";
  const stateRaw = String(pick.state || pick.status || "pending").toLowerCase();
  let state = "pending";
  if (stateRaw === "won" || stateRaw === "ganada") state = "won";
  else if (stateRaw === "lost" || stateRaw === "perdida") state = "lost";

  return {
    sport: String(pick.sport || "football").trim().toLowerCase() || "football",
    league: pick.league || null,
    home_team_name: String(home).trim() || "Local",
    home_team_logo: String(homeLogo || ""),
    away_team_name: String(away).trim() || "Visitante",
    away_team_logo: String(awayLogo || ""),
    prediction,
    confidence:
      typeof pick.confidence === "number"
        ? pick.confidence
        : Number.parseInt(pick.confidence, 10) || null,
    odds:
      typeof pick.odds === "number"
        ? pick.odds
        : Number.parseFloat(pick.odds) || 0,
    match_date: /^\d{4}-\d{2}-\d{2}$/.test(matchDate) ? matchDate : null,
    match_hour: matchHour,
    state,
    updated_at: new Date().toISOString(),
  };
}

function productionDedupeKey(row) {
  const home = normalizeTeamToken(row.home_team_name);
  const away = normalizeTeamToken(row.away_team_name);
  const date = String(row.match_date || "").slice(0, 10);
  const market = normalizePickLabel(row.prediction);
  return `${home}|${away}|${date}|${market}`;
}

async function loadProductionKeysForDate(table, matchDate) {
  const { data, error } = await db
    .from(table)
    .select("home_team_name,away_team_name,prediction,match_date")
    .eq("match_date", matchDate)
    .limit(500);

  if (error) {
    throw new Error(error.message || `Error leyendo ${table} para dedupe`);
  }

  const keys = new Set();
  for (const row of data || []) {
    keys.add(productionDedupeKey(row));
  }
  return keys;
}

/**
 * Inserta un pick de fábrica en abet / abetvip si no existe ya (mismo cruce + día + mercado).
 */
async function publishPickToProduction(pick, tier = "free") {
  if (!isAutoPublishEnabled()) {
    return { published: false, reason: "disabled" };
  }

  const table = tier === "vip" ? VIP_PROD : FREE_PROD;
  const row = mapPickToProductionRow(pick);
  if (!row.match_date || !row.prediction) {
    return { published: false, reason: "incomplete" };
  }

  const existing = await loadProductionKeysForDate(table, row.match_date);
  const key = productionDedupeKey(row);
  if (existing.has(key)) {
    return { published: false, reason: "duplicate", table };
  }

  const { error } = await db.from(table).insert(row);
  if (error) {
    throw new Error(error.message || `Error publicando en ${table}`);
  }
  return { published: true, table };
}

/**
 * Publica la cola del día (free_picks / vip_picks) a tablas de producción.
 * Deduplica por partido+mercado para no inundar abet con la cola duplicada.
 */
async function publishQueueDayToProduction(matchDate) {
  if (!isAutoPublishEnabled()) {
    return { skipped: true, reason: "disabled", free: 0, vip: 0 };
  }

  const day =
    typeof matchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(matchDate.trim())
      ? matchDate.trim()
      : todayIsoDate();

  const [freeRows, vipRows, freeKeys, vipKeys] = await Promise.all([
    getFreePredictions(500, { todayOnly: true, date: day }),
    getVipPredictions(500, { todayOnly: true, date: day }),
    loadProductionKeysForDate(FREE_PROD, day),
    loadProductionKeysForDate(VIP_PROD, day),
  ]);

  let publishedFree = 0;
  let publishedVip = 0;
  const seenFree = new Set(freeKeys);
  const seenVip = new Set(vipKeys);
  /** Un mercado por partido/día en cada tier (alineado al panel de planta). */
  const fixtureSeenFree = new Set();
  const fixtureSeenVip = new Set();

  for (const row of freeRows) {
    const prod = mapPickToProductionRow(row);
    if (!prod.match_date || !prod.prediction) continue;
    const fk = fixtureTierDedupeKey(row);
    if (fixtureSeenFree.has(fk)) continue;
    const key = productionDedupeKey(prod);
    if (seenFree.has(key)) {
      fixtureSeenFree.add(fk);
      continue;
    }
    const { error } = await db.from(FREE_PROD).insert(prod);
    if (error) {
      logger.warn(`[publish] abet: ${error.message}`);
      continue;
    }
    seenFree.add(key);
    fixtureSeenFree.add(fk);
    publishedFree += 1;
  }

  for (const row of vipRows) {
    const prod = mapPickToProductionRow(row);
    if (!prod.match_date || !prod.prediction) continue;
    const fk = fixtureTierDedupeKey(row);
    if (fixtureSeenVip.has(fk)) continue;
    const key = productionDedupeKey(prod);
    if (seenVip.has(key)) {
      fixtureSeenVip.add(fk);
      continue;
    }
    const { error } = await db.from(VIP_PROD).insert(prod);
    if (error) {
      logger.warn(`[publish] abetvip: ${error.message}`);
      continue;
    }
    seenVip.add(key);
    fixtureSeenVip.add(fk);
    publishedVip += 1;
  }

  logger.info(
    `Publicados a planta día=${day}: free=+${publishedFree} → ${FREE_PROD}, vip=+${publishedVip} → ${VIP_PROD}`
  );

  return {
    skipped: false,
    match_date: day,
    free: publishedFree,
    vip: publishedVip,
  };
}

module.exports = {
  isAutoPublishEnabled,
  publishPickToProduction,
  publishQueueDayToProduction,
  mapPickToProductionRow,
};
