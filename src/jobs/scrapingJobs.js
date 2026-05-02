const { runAllPredictionScrapers } = require("../services/scraperService");
const {
  splitFreeAndVipPredictions,
  buildTierPredictionsFromScraped,
  buildPredictionsFromFixtures,
} = require("../services/predictionEngine");
const { createFreePrediction, getFreePredictions } = require("../models/predictionModel");
const { createVipPrediction, getVipPredictions } = require("../models/vipModel");
const { getTodayFixturesBySport } = require("../services/sportsService");
const { prioritizeFixtures } = require("../services/fixturePriorityService");
const { getPredictionSourcePolicy, toHost } = require("../services/sourceService");
const { generateAiPredictionsFromFixtures } = require("../services/aiForecastService");
const { mergeDedupeByKey } = require("../utils/predictionDedupe");
const { formatDateInTimezone } = require("../utils/helpers");
const logger = require("../utils/logger");

function buildMatchKey(row) {
  const home = row.homeTeam?.name || row.home_team_name || row.team_a || "";
  const away = row.awayTeam?.name || row.away_team_name || row.team_b || "";
  const date = row.date || row.match_date || "";
  const market = row.prediction || row.pick_text || "";
  return `${home.toLowerCase()}|${away.toLowerCase()}|${date}|${String(market).toLowerCase()}`;
}

async function runPredictionPipeline(options = {}) {
  const sport = options.sport || "football";
  const timezone = process.env.FACTORY_TIMEZONE || "America/Bogota";
  const matchDateIso =
    typeof options.matchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.matchDate.trim())
      ? options.matchDate.trim()
      : null;
  const calendarDayIso = matchDateIso || formatDateInTimezone(new Date(), timezone);
  logger.info(
    `Iniciando pipeline de scraping + predicción (${sport}, día=${calendarDayIso})...`
  );
  const scraperEnabled = process.env.FACTORY_ENABLE_EXTERNAL_SCRAPERS === "true";
  let fixtures = [];
  try {
    fixtures = await getTodayFixturesBySport(sport, matchDateIso || undefined);
  } catch (error) {
    logger.warn(`No se pudieron leer fixtures ${sport}: ${error.message}`);
  }
  const prioritizedFixtures = sport === "football" ? prioritizeFixtures(fixtures) : fixtures;

  const scraped = sport === "football" && scraperEnabled ? await runAllPredictionScrapers() : [];
  if (sport === "football" && !scraperEnabled) {
    logger.info("Scrapers externos deshabilitados. Usando solo fuentes de fixtures.");
  }

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

  const fromFixtures = buildPredictionsFromFixtures(prioritizedFixtures, { free: 10, vip: 10 });
  const aiFromFixtures =
    sport === "football"
      ? await generateAiPredictionsFromFixtures(prioritizedFixtures)
      : { free: [], vip: [] };
  const fromScrapers = splitFreeAndVipPredictions(scrapedForFree, sport, { free: 10, vip: 10 });
  const vipFromReliableScrapers = buildTierPredictionsFromScraped(
    scrapedForVip,
    sport,
    "vip",
    10
  );

  /** IA DeepSeek primero; luego scrapers; último motor por fixtures — sin repetir mismo partido+mercado. */
  const freePicks = mergeDedupeByKey(
    [aiFromFixtures.free, fromScrapers.free, fromFixtures.free],
    buildMatchKey
  );
  const vipPicks = mergeDedupeByKey(
    [aiFromFixtures.vip, vipFromReliableScrapers, fromFixtures.vip, fromScrapers.vip],
    buildMatchKey
  );

  const [existingFree, existingVip] = await Promise.all([
    getFreePredictions(500, { todayOnly: true, date: calendarDayIso, sport }),
    getVipPredictions(500, { todayOnly: true, date: calendarDayIso, sport }),
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
    `Pipeline completado (${sport}): fixtures=${fixtures.length}, prioritized=${prioritizedFixtures.length}, scraped=${scraped.length}, free=${insertedFree}, vip=${insertedVip}, strictVip=${sourcePolicy.strict_vip}`
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
