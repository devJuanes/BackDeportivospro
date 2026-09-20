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
const { scrubPlayStoreText } = require("../utils/playStoreSafe");
const {
  getDailyCap,
  getMaxPicksPerMatch,
  shouldAcceptPickForFixture,
} = require("../utils/pickVolume");
const { enrichPickLogos } = require("./futboolLogoService");
const logger = require("../utils/logger");

const FREE_PROD = process.env.FACTORY_PROD_FREE_TABLE || "abet";
const VIP_PROD = process.env.FACTORY_PROD_VIP_TABLE || "abetvip";

function isAutoPublishEnabled() {
  /** Default ON: fábrica → MatuDB plant (abet/abetvip) sin gate humano. Opt-out: FACTORY_AUTO_PUBLISH=false */
  return String(process.env.FACTORY_AUTO_PUBLISH || "true").toLowerCase() !== "false";
}

function todayIsoDate() {
  return formatDateInTimezone(
    new Date(),
    process.env.FACTORY_TIMEZONE || "America/Bogota"
  );
}

function mapPickToProductionRow(pick) {
  enrichPickLogos(pick);

  const home =
    pick.homeTeam?.name || pick.home_team_name || pick.team_a || "";
  const away =
    pick.awayTeam?.name || pick.away_team_name || pick.team_b || "";
  const matchDate = String(pick.date || pick.match_date || "").slice(0, 10);
  const matchHour = normalizeMatchHour(pick.hours || pick.match_hour);
  const prediction = scrubPlayStoreText(
    String(pick.prediction || pick.pick_text || "").trim()
  );
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

  const dailyCap = getDailyCap(tier);
  const { data: dayRows } = await db
    .from(table)
    .select("id")
    .eq("match_date", row.match_date)
    .limit(dailyCap + 5);
  if ((dayRows || []).length >= dailyCap) {
    return { published: false, reason: "daily_cap", table, cap: dailyCap };
  }

  const existing = await loadProductionKeysForDate(table, row.match_date);
  const key = productionDedupeKey(row);
  const fixtureKey = fixtureTierDedupeKey(row);
  if (existing.has(key)) {
    return { published: false, reason: "duplicate", table };
  }
  // Máx. N tips/partido: el 2º solo con mercado distinto + confianza alta.
  const { data: sameFixtureRows } = await db
    .from(table)
    .select("prediction,confidence")
    .eq("match_date", row.match_date)
    .eq("home_team_name", row.home_team_name)
    .eq("away_team_name", row.away_team_name)
    .limit(20);
  if (
    !shouldAcceptPickForFixture({
      existingPicks: sameFixtureRows || [],
      candidate: row,
      tier,
    })
  ) {
    return { published: false, reason: "fixture_covered", table, fixtureKey };
  }

  const { error } = await db.from(table).insert(row);
  if (error) {
    throw new Error(error.message || `Error publicando en ${table}`);
  }
  try {
    const { notifyNewPublishedPick } = require("./predictionNotifyService");
    await notifyNewPublishedPick(row, tier);
  } catch {
    /* push opcional */
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

  const [freeRows, vipRows, freeKeys, vipKeys, plantSnapshot] = await Promise.all([
    getFreePredictions(500, { todayOnly: true, date: day }),
    getVipPredictions(500, { todayOnly: true, date: day }),
    loadProductionKeysForDate(FREE_PROD, day),
    loadProductionKeysForDate(VIP_PROD, day),
    loadProductionFixtureKeysForDate(day),
  ]);

  let publishedFree = 0;
  let publishedVip = 0;
  const seenFree = new Set(freeKeys);
  const seenVip = new Set(vipKeys);
  const maxPerMatch = getMaxPicksPerMatch();
  const dailyCapFree = getDailyCap("free");
  const dailyCapVip = getDailyCap("vip");
  let freePlantTotal = plantSnapshot.freeCount || 0;
  let vipPlantTotal = plantSnapshot.vipCount || 0;

  /** Precargar tips ya en planta por partido. */
  const fixturePicksFree = new Map();
  const fixturePicksVip = new Map();
  async function preloadPlantFixturePicks(table, map) {
    try {
      const { data } = await db
        .from(table)
        .select("sport,home_team_name,away_team_name,match_date,prediction,confidence")
        .eq("match_date", day)
        .limit(600);
      for (const row of data || []) {
        const fk = fixtureTierDedupeKey(row);
        if (!map.has(fk)) map.set(fk, []);
        map.get(fk).push(row);
      }
    } catch {
      /* noop */
    }
  }
  await Promise.all([
    preloadPlantFixturePicks(FREE_PROD, fixturePicksFree),
    preloadPlantFixturePicks(VIP_PROD, fixturePicksVip),
  ]);

  for (const row of freeRows) {
    if (freePlantTotal >= dailyCapFree) break;
    const prod = mapPickToProductionRow(row);
    if (!prod.match_date || !prod.prediction) continue;
    const fk = fixtureTierDedupeKey(row);
    const existingFx = fixturePicksFree.get(fk) || [];
    if (existingFx.length >= maxPerMatch) continue;
    const key = productionDedupeKey(prod);
    if (seenFree.has(key)) continue;
    if (!shouldAcceptPickForFixture({ existingPicks: existingFx, candidate: prod, tier: "free" })) {
      continue;
    }
    const { error } = await db.from(FREE_PROD).insert(prod);
    if (error) {
      logger.warn(`[publish] abet: ${error.message}`);
      continue;
    }
    seenFree.add(key);
    if (!fixturePicksFree.has(fk)) fixturePicksFree.set(fk, []);
    fixturePicksFree.get(fk).push(prod);
    publishedFree += 1;
    freePlantTotal += 1;
  }

  for (const row of vipRows) {
    if (vipPlantTotal >= dailyCapVip) break;
    const prod = mapPickToProductionRow(row);
    if (!prod.match_date || !prod.prediction) continue;
    const fk = fixtureTierDedupeKey(row);
    const existingFx = fixturePicksVip.get(fk) || [];
    if (existingFx.length >= maxPerMatch) continue;
    const key = productionDedupeKey(prod);
    if (seenVip.has(key)) continue;
    if (!shouldAcceptPickForFixture({ existingPicks: existingFx, candidate: prod, tier: "vip" })) {
      continue;
    }
    const { error } = await db.from(VIP_PROD).insert(prod);
    if (error) {
      logger.warn(`[publish] abetvip: ${error.message}`);
      continue;
    }
    seenVip.add(key);
    if (!fixturePicksVip.has(fk)) fixturePicksVip.set(fk, []);
    fixturePicksVip.get(fk).push(prod);
    publishedVip += 1;
    vipPlantTotal += 1;
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

async function loadProductionFixtureKeysForDate(matchDate) {
  const freeKeys = new Set();
  const vipKeys = new Set();
  let freeCount = 0;
  let vipCount = 0;
  for (const [tier, table, set] of [
    ["free", FREE_PROD, freeKeys],
    ["vip", VIP_PROD, vipKeys],
  ]) {
    try {
      const { data, error } = await db
        .from(table)
        .select("sport,home_team_name,away_team_name,match_date,prediction,confidence")
        .eq("match_date", matchDate)
        .limit(600);
      if (error) continue;
      const rows = data || [];
      if (tier === "free") freeCount = rows.length;
      else vipCount = rows.length;
      for (const row of rows) {
        set.add(fixtureTierDedupeKey(row));
      }
    } catch {
      /* noop */
    }
  }
  return { free: freeKeys, vip: vipKeys, freeCount, vipCount };
}

module.exports = {
  isAutoPublishEnabled,
  publishPickToProduction,
  publishQueueDayToProduction,
  mapPickToProductionRow,
  productionDedupeKey,
  loadProductionKeysForDate,
  loadProductionFixtureKeysForDate,
};
