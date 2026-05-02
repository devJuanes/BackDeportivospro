const { runAllPredictionScrapers } = require("../services/scraperService");
const {
  splitFreeAndVipPredictions,
  buildTierPredictionsFromScraped,
  buildPredictionsFromFixtures,
} = require("../services/predictionEngine");
const { createFreePrediction, getFreePredictions } = require("../models/predictionModel");
const { createVipPrediction, getVipPredictions } = require("../models/vipModel");
const { getTodayFixturesBySport } = require("../services/sportsService");
const { prioritizeFixtures, diversifyFixtures } = require("../services/fixturePriorityService");
const { getPredictionSourcePolicy, toHost } = require("../services/sourceService");
const { generateAiPredictionsFromFixtures } = require("../services/aiForecastService");
const { mergeDedupeByKey, normalizePickLabel, fixtureTierDedupeKey, normalizeTeamToken, pairKey } = require("../utils/predictionDedupe");
const { formatDateInTimezone } = require("../utils/helpers");
const logger = require("../utils/logger");

function buildMatchKey(row) {
  const home = row.homeTeam?.name || row.home_team_name || row.team_a || "";
  const away = row.awayTeam?.name || row.away_team_name || row.team_b || "";
  const date = row.date || row.match_date || "";
  const market = normalizePickLabel(row.prediction || row.pick_text || "");
  return `${home.toLowerCase()}|${away.toLowerCase()}|${date}|${market}`;
}

function fixtureKeyForTier(fixture, sport) {
  const home = normalizeTeamToken(fixture.homeTeam || fixture.home_team_name || fixture.team_a || "");
  const away = normalizeTeamToken(fixture.awayTeam || fixture.away_team_name || fixture.team_b || "");
  const date = String(fixture.match_date || fixture.date || "").slice(0, 10);
  return `${String(sport || "football").toLowerCase()}|${pairKey(home, away)}|${date}`;
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
  const rotationPool = Number.parseInt(process.env.FACTORY_FIXTURE_ROTATION_POOL || "80", 10);
  const rotationWindowMin = Number.parseInt(process.env.FACTORY_FIXTURE_ROTATION_WINDOW_MIN || "15", 10);
  const rotationSeed = Math.floor(Date.now() / (Math.max(1, rotationWindowMin) * 60 * 1000));
  /** Orden real por liga/importancia (sin barajar): la IA debe verse primero en estos partidos. */
  const fixturesByPriority =
    sport === "football" ? prioritizeFixtures(fixtures, calendarDayIso) : fixtures;
  /** Lista barajada solo para ampliar cobertura en motor/scrapers; no debe “esconder” los top a la IA. */
  const prioritizedFixtures =
    sport === "football"
      ? diversifyFixtures(fixturesByPriority, rotationPool, rotationSeed)
      : fixtures;

  const batchFree = Number.parseInt(process.env.FACTORY_BATCH_FREE || "60", 10);
  const batchVip = Number.parseInt(process.env.FACTORY_BATCH_VIP || "60", 10);

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

  /** Existentes del día: claves por fixture+tier para NO gastar IA en partidos ya cubiertos. */
  const [existingFree, existingVip] = await Promise.all([
    getFreePredictions(500, { todayOnly: true, date: calendarDayIso, sport }),
    getVipPredictions(500, { todayOnly: true, date: calendarDayIso, sport }),
  ]);
  const existingFreeKeys = new Set(existingFree.map(buildMatchKey));
  const existingVipKeys = new Set(existingVip.map(buildMatchKey));
  const existingFixtureFree = new Set(existingFree.map((r) => fixtureTierDedupeKey(r)));
  const existingFixtureVip = new Set(existingVip.map((r) => fixtureTierDedupeKey(r)));

  /** Fixtures sin pick FREE y sin pick VIP (lo que falta cubrir HOY). Mantiene orden de prioridad. */
  const uncoveredForFree = fixturesByPriority.filter(
    (f) => !existingFixtureFree.has(fixtureKeyForTier(f, sport))
  );
  const uncoveredForVip = fixturesByPriority.filter(
    (f) => !existingFixtureVip.has(fixtureKeyForTier(f, sport))
  );

  /** IA: prioriza fixtures sin cubrir (free o vip). Si ya está todo cubierto, usa los top normales. */
  const aiTargetSet = new Map();
  for (const f of uncoveredForFree) aiTargetSet.set(fixtureKeyForTier(f, sport), f);
  for (const f of uncoveredForVip) {
    const k = fixtureKeyForTier(f, sport);
    if (!aiTargetSet.has(k)) aiTargetSet.set(k, f);
  }
  const aiTargets = Array.from(aiTargetSet.values());
  const aiInputFixtures = aiTargets.length > 0 ? aiTargets : fixturesByPriority;

  const fromFixtures = buildPredictionsFromFixtures(prioritizedFixtures, {
    free: batchFree,
    vip: batchVip,
  });
  const aiFromFixtures =
    sport === "football"
      ? await generateAiPredictionsFromFixtures(aiInputFixtures)
      : { free: [], vip: [] };
  const fromScrapers = splitFreeAndVipPredictions(scrapedForFree, sport, { free: batchFree, vip: batchVip });
  const vipFromReliableScrapers = buildTierPredictionsFromScraped(
    scrapedForVip,
    sport,
    "vip",
    batchVip
  );

  /** IA → scrapers → motor fixtures; sin repetir mercado; luego un solo pick por partido/día y tier. */
  const freePicks = mergeDedupeByKey(
    [
      mergeDedupeByKey([aiFromFixtures.free, fromScrapers.free, fromFixtures.free], buildMatchKey),
    ],
    fixtureTierDedupeKey
  );
  const vipPicks = mergeDedupeByKey(
    [
      mergeDedupeByKey(
        [aiFromFixtures.vip, vipFromReliableScrapers, fromFixtures.vip, fromScrapers.vip],
        buildMatchKey
      ),
    ],
    fixtureTierDedupeKey
  );

  let insertedFree = 0;
  let insertedVip = 0;
  for (const pick of freePicks) {
    const key = buildMatchKey(pick);
    const fk = fixtureTierDedupeKey(pick);
    if (existingFixtureFree.has(fk) || existingFreeKeys.has(key)) {
      continue;
    }
    await createFreePrediction(pick);
    insertedFree += 1;
    existingFreeKeys.add(key);
    existingFixtureFree.add(fk);
  }
  for (const pick of vipPicks) {
    const key = buildMatchKey(pick);
    const fk = fixtureTierDedupeKey(pick);
    if (existingFixtureVip.has(fk) || existingVipKeys.has(key)) {
      continue;
    }
    await createVipPrediction(pick);
    insertedVip += 1;
    existingVipKeys.add(key);
    existingFixtureVip.add(fk);
  }

  logger.info(
    `Pipeline (${sport}) día=${calendarDayIso} fixtures=${fixtures.length} prioritized=${prioritizedFixtures.length} ` +
    `uncovered_free=${uncoveredForFree.length} uncovered_vip=${uncoveredForVip.length} ai_target=${aiInputFixtures.length} ` +
    `scraped=${scraped.length} insertados free=+${insertedFree} vip=+${insertedVip} ` +
    `total_dia free=${existingFree.length + insertedFree} vip=${existingVip.length + insertedVip}`
  );
  return {
    free: insertedFree,
    vip: insertedVip,
    sport,
    fixtures_total: fixtures.length,
    fixtures_uncovered_free: uncoveredForFree.length,
    fixtures_uncovered_vip: uncoveredForVip.length,
  };
}

module.exports = {
  runPredictionPipeline,
};
