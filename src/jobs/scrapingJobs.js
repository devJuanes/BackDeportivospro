const { runAllPredictionScrapers } = require("../services/scraperService");
const {
  splitFreeAndVipPredictions,
  buildTierPredictionsFromScraped,
  buildPredictionsFromFixtures,
} = require("../services/predictionEngine");
const { createFreePrediction, getFreePredictions } = require("../models/predictionModel");
const { createVipPrediction, getVipPredictions } = require("../models/vipModel");
const { getTodayFixturesBySport } = require("../services/sportsService");
const { getPredictionSourcePolicy, toHost } = require("../services/sourceService");
const logger = require("../utils/logger");

function buildMatchKey(row) {
  const home = row.homeTeam?.name || row.home_team_name || "";
  const away = row.awayTeam?.name || row.away_team_name || "";
  const date = row.date || row.match_date || "";
  return `${home.toLowerCase()}|${away.toLowerCase()}|${date}`;
}

async function runPredictionPipeline(options = {}) {
  const sport = options.sport || "football";
  logger.info(`Iniciando pipeline de scraping + predicción (${sport})...`);
  let fixtures = [];
  try {
    fixtures = await getTodayFixturesBySport(sport);
  } catch (error) {
    logger.warn(`No se pudieron leer fixtures ${sport}: ${error.message}`);
  }

  const scraped = sport === "football" ? await runAllPredictionScrapers() : [];

  let sourcePolicy = {
    sport,
    vip_hosts: [],
    free_hosts: [],
    strict_vip: false,
  };
  try {
    sourcePolicy = await getPredictionSourcePolicy(sport);
  } catch (error) {
    logger.warn(`No se pudo cargar política de fuentes ${sport}: ${error.message}`);
  }

  const scrapedForFree = scraped.filter((row) => {
    const host = toHost(row.source_url || row.source || "");
    return sourcePolicy.free_hosts.length === 0 || sourcePolicy.free_hosts.includes(host);
  });
  const scrapedForVip = scraped.filter((row) => {
    const host = toHost(row.source_url || row.source || "");
    return sourcePolicy.vip_hosts.length === 0 || sourcePolicy.vip_hosts.includes(host);
  });

  const fromFixtures = buildPredictionsFromFixtures(fixtures, { free: 10, vip: 10 });
  const fromScrapers = splitFreeAndVipPredictions(scrapedForFree, sport, { free: 10, vip: 10 });
  const vipFromReliableScrapers = buildTierPredictionsFromScraped(
    scrapedForVip,
    sport,
    "vip",
    10
  );

  const freePicks = fromFixtures.free.length > 0 ? fromFixtures.free : fromScrapers.free;
  const vipPicks =
    vipFromReliableScrapers.length > 0
      ? vipFromReliableScrapers
      : fromFixtures.vip.length > 0
        ? fromFixtures.vip
        : fromScrapers.vip;

  const [existingFree, existingVip] = await Promise.all([
    getFreePredictions(500, { todayOnly: true, sport }),
    getVipPredictions(500, { todayOnly: true, sport }),
  ]);

  const existingFreeKeys = new Set(existingFree.map(buildMatchKey));
  const existingVipKeys = new Set(existingVip.map(buildMatchKey));

  let insertedFree = 0;
  let insertedVip = 0;
  for (const pick of freePicks) {
    const key = buildMatchKey(pick);
    if (existingFreeKeys.has(key)) {
      continue;
    }
    await createFreePrediction(pick);
    insertedFree += 1;
    existingFreeKeys.add(key);
  }
  for (const pick of vipPicks) {
    const key = buildMatchKey(pick);
    if (existingVipKeys.has(key) || existingFreeKeys.has(key)) {
      continue;
    }
    await createVipPrediction(pick);
    insertedVip += 1;
    existingVipKeys.add(key);
  }

  logger.info(
    `Pipeline completado (${sport}): fixtures=${fixtures.length}, scraped=${scraped.length}, free=${insertedFree}, vip=${insertedVip}, strictVip=${sourcePolicy.strict_vip}`
  );
  return {
    free: insertedFree,
    vip: insertedVip,
    sport,
  };
}

module.exports = {
  runPredictionPipeline,
};
