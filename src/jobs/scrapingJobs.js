const { runAllPredictionScrapers } = require("../services/scraperService");
const {
  splitFreeAndVipPredictions,
  buildTierPredictionsFromScraped,
  buildPredictionsFromFixtures,
} = require("../services/predictionEngine");
const { createFreePrediction, getFreePredictions } = require("../models/predictionModel");
const { createVipPrediction, getVipPredictions } = require("../models/vipModel");
const { getTodayFixturesBySport, getTodayFootballFixturesLatam } = require("../services/sportsService");
const { prioritizeFixtures, diversifyFixtures } = require("../services/fixturePriorityService");
const { getPredictionSourcePolicy, toHost } = require("../services/sourceService");
const { generateAiPredictionsFromFixtures } = require("../services/aiForecastService");
const {
  publishPickToProduction,
  loadProductionFixtureKeysForDate,
} = require("../services/productionPublishService");
const { mergeDedupeByKey, normalizePickLabel, fixtureTierDedupeKey, normalizeTeamToken, pairKey } = require("../utils/predictionDedupe");
const { filterFixturesForTips, filterQualityPicks } = require("../utils/fixtureQuality");
const {
  getDailyCap,
  getMaxPicksPerMatch,
  shouldAcceptPickForFixture,
  selectTopPicksPerFixture,
} = require("../utils/pickVolume");
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
  const latamOnly = options.latamOnly === true;
  const timezone = process.env.FACTORY_TIMEZONE || "America/Bogota";
  const matchDateIso =
    typeof options.matchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.matchDate.trim())
      ? options.matchDate.trim()
      : null;
  const calendarDayIso = matchDateIso || formatDateInTimezone(new Date(), timezone);
  logger.info(
    `Iniciando pipeline de scraping + predicción (${sport}, día=${calendarDayIso}${latamOnly ? ", modo=LATAM" : ""})...`
  );
  const scraperEnabled = process.env.FACTORY_ENABLE_EXTERNAL_SCRAPERS === "true";
  let fixtures = [];
  try {
    if (sport === "football" && latamOnly) {
      fixtures = await getTodayFootballFixturesLatam(matchDateIso || undefined);
    } else {
      fixtures = await getTodayFixturesBySport(sport, matchDateIso || undefined);
    }
  } catch (error) {
    logger.warn(`No se pudieron leer fixtures ${sport}: ${error.message}`);
  }
  const beforeFilter = fixtures.length;
  fixtures = filterFixturesForTips(fixtures, { allowLive: false });
  if (beforeFilter !== fixtures.length) {
    logger.info(
      `Fixtures ${sport}: ${beforeFilter} → ${fixtures.length} (próximos reales, sin basura)`
    );
  }
  const rotationPool = Number.parseInt(process.env.FACTORY_FIXTURE_ROTATION_POOL || "80", 10);
  const rotationWindowMin = Number.parseInt(process.env.FACTORY_FIXTURE_ROTATION_WINDOW_MIN || "15", 10);
  const rotationSeed = Math.floor(Date.now() / (Math.max(1, rotationWindowMin) * 60 * 1000));
  /** Orden real por liga/importancia (sin barajar): la IA debe verse primero en estos partidos. */
  const fixturesByPriority = prioritizeFixtures(fixtures, calendarDayIso);
  /** Lista barajada solo para ampliar cobertura en motor/scrapers; no debe “esconder” los top a la IA. */
  const prioritizedFixtures = diversifyFixtures(fixturesByPriority, rotationPool, rotationSeed);

  const batchFree = Number.parseInt(
    latamOnly ? process.env.FACTORY_LATAM_BATCH_FREE || "45" : process.env.FACTORY_BATCH_FREE || "60",
    10
  );
  const batchVip = Number.parseInt(
    latamOnly ? process.env.FACTORY_LATAM_BATCH_VIP || "45" : process.env.FACTORY_BATCH_VIP || "60",
    10
  );

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

  const maxPerMatch = getMaxPicksPerMatch();
  const dailyCapFree = getDailyCap("free");
  const dailyCapVip = getDailyCap("vip");

  /** Existentes del día: claves por mercado + lista por partido (máx. N tips). */
  const [existingFree, existingVip] = await Promise.all([
    getFreePredictions(500, { todayOnly: true, date: calendarDayIso, sport }),
    getVipPredictions(500, { todayOnly: true, date: calendarDayIso, sport }),
  ]);
  const existingFreeKeys = new Set(existingFree.map(buildMatchKey));
  const existingVipKeys = new Set(existingVip.map(buildMatchKey));
  /** fixtureKey → picks ya guardados (cola + planta). */
  const picksByFixtureFree = new Map();
  const picksByFixtureVip = new Map();
  const addExisting = (map, row) => {
    const k = fixtureTierDedupeKey(row);
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  };
  for (const r of existingFree) addExisting(picksByFixtureFree, r);
  for (const r of existingVip) addExisting(picksByFixtureVip, r);

  /** También considerar lo ya publicado en planta (abet/abetvip) para no duplicar local+prod. */
  let plantFreeCount = 0;
  let plantVipCount = 0;
  try {
    const prodKeys = await loadProductionFixtureKeysForDate(calendarDayIso);
    plantFreeCount = prodKeys.freeCount || prodKeys.free?.size || 0;
    plantVipCount = prodKeys.vipCount || prodKeys.vip?.size || 0;
    for (const k of prodKeys.free || []) {
      if (!picksByFixtureFree.has(k)) picksByFixtureFree.set(k, [{ _plant: true }]);
      else if ((picksByFixtureFree.get(k) || []).length < maxPerMatch) {
        picksByFixtureFree.get(k).push({ _plant: true });
      }
    }
    for (const k of prodKeys.vip || []) {
      if (!picksByFixtureVip.has(k)) picksByFixtureVip.set(k, [{ _plant: true }]);
      else if ((picksByFixtureVip.get(k) || []).length < maxPerMatch) {
        picksByFixtureVip.get(k).push({ _plant: true });
      }
    }
  } catch (error) {
    logger.warn(`[pipeline] claves planta ${calendarDayIso}: ${error.message}`);
  }

  const freeDayTotal = Math.max(existingFree.length, plantFreeCount);
  const vipDayTotal = Math.max(existingVip.length, plantVipCount);
  if (freeDayTotal >= dailyCapFree && vipDayTotal >= dailyCapVip) {
    logger.info(
      `[pipeline] tope diario alcanzado (${sport}) free=${freeDayTotal}/${dailyCapFree} vip=${vipDayTotal}/${dailyCapVip} — skip`
    );
    return {
      free: 0,
      vip: 0,
      published_free: 0,
      published_vip: 0,
      sport,
      latam_only: latamOnly,
      skipped_daily_cap: true,
      fixtures_total: fixtures.length,
    };
  }

  /** Fixtures sin cubrir del todo (menos de maxPerMatch tips). */
  const uncoveredForFree = fixturesByPriority.filter((f) => {
    const k = fixtureKeyForTier(f, sport);
    return (picksByFixtureFree.get(k) || []).length < maxPerMatch;
  });
  const uncoveredForVip = fixturesByPriority.filter((f) => {
    const k = fixtureKeyForTier(f, sport);
    return (picksByFixtureVip.get(k) || []).length < maxPerMatch;
  });

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
  const aiMatchLimit =
    sport === "football" && latamOnly
      ? Number.parseInt(process.env.FACTORY_LATAM_AI_MATCH_LIMIT || "40", 10)
      : sport !== "football"
        ? Number.parseInt(process.env.FACTORY_AI_MATCH_LIMIT_OTHER || process.env.FACTORY_AI_MATCH_LIMIT || "12", 10)
        : undefined;
  /** IA multi-deporte (Minimax agent): research → analysis → tip → cola + planta. */
  const aiFromFixtures = await generateAiPredictionsFromFixtures(aiInputFixtures, {
    matchLimit: aiMatchLimit,
  });
  const fromScrapers = splitFreeAndVipPredictions(scrapedForFree, sport, { free: batchFree, vip: batchVip });
  const vipFromReliableScrapers = buildTierPredictionsFromScraped(
    scrapedForVip,
    sport,
    "vip",
    batchVip
  );

  /** IA → scrapers → motor; sin mercado duplicado; máx. N tips/partido (calidad). */
  const freePicks = selectTopPicksPerFixture(
    filterQualityPicks(
      mergeDedupeByKey([aiFromFixtures.free, fromScrapers.free, fromFixtures.free], buildMatchKey),
      "free"
    ),
    "free"
  );
  const vipPicks = selectTopPicksPerFixture(
    filterQualityPicks(
      mergeDedupeByKey(
        [aiFromFixtures.vip, vipFromReliableScrapers, fromFixtures.vip, fromScrapers.vip],
        buildMatchKey
      ),
      "vip"
    ),
    "vip"
  );

  let insertedFree = 0;
  let insertedVip = 0;
  let publishedFree = 0;
  let publishedVip = 0;
  let freeInsertedToday = freeDayTotal;
  let vipInsertedToday = vipDayTotal;

  for (const pick of freePicks) {
    if (freeInsertedToday >= dailyCapFree) break;
    const key = buildMatchKey(pick);
    const fk = fixtureTierDedupeKey(pick);
    if (existingFreeKeys.has(key)) continue;
    const existingForFixture = picksByFixtureFree.get(fk) || [];
    if (!shouldAcceptPickForFixture({ existingPicks: existingForFixture, candidate: pick, tier: "free" })) {
      continue;
    }
    await createFreePrediction(pick);
    insertedFree += 1;
    freeInsertedToday += 1;
    existingFreeKeys.add(key);
    if (!picksByFixtureFree.has(fk)) picksByFixtureFree.set(fk, []);
    picksByFixtureFree.get(fk).push(pick);
    try {
      const pub = await publishPickToProduction(pick, "free");
      if (pub.published) publishedFree += 1;
    } catch (error) {
      logger.warn(`[publish] free ${pick.homeTeam?.name || ""}: ${error.message}`);
    }
  }
  for (const pick of vipPicks) {
    if (vipInsertedToday >= dailyCapVip) break;
    const key = buildMatchKey(pick);
    const fk = fixtureTierDedupeKey(pick);
    if (existingVipKeys.has(key)) continue;
    const existingForFixture = picksByFixtureVip.get(fk) || [];
    if (!shouldAcceptPickForFixture({ existingPicks: existingForFixture, candidate: pick, tier: "vip" })) {
      continue;
    }
    await createVipPrediction(pick);
    insertedVip += 1;
    vipInsertedToday += 1;
    existingVipKeys.add(key);
    if (!picksByFixtureVip.has(fk)) picksByFixtureVip.set(fk, []);
    picksByFixtureVip.get(fk).push(pick);
    try {
      const pub = await publishPickToProduction(pick, "vip");
      if (pub.published) publishedVip += 1;
    } catch (error) {
      logger.warn(`[publish] vip ${pick.homeTeam?.name || ""}: ${error.message}`);
    }
  }

  logger.info(
    `Pipeline (${sport}) día=${calendarDayIso} fixtures=${fixtures.length} prioritized=${prioritizedFixtures.length} ` +
    `uncovered_free=${uncoveredForFree.length} uncovered_vip=${uncoveredForVip.length} ai_target=${aiInputFixtures.length} ` +
    `scraped=${scraped.length} insertados free=+${insertedFree} vip=+${insertedVip} ` +
    `planta free=+${publishedFree} vip=+${publishedVip} ` +
    `cap free=${freeInsertedToday}/${dailyCapFree} vip=${vipInsertedToday}/${dailyCapVip} maxPerMatch=${maxPerMatch}`
  );
  return {
    free: insertedFree,
    vip: insertedVip,
    published_free: publishedFree,
    published_vip: publishedVip,
    sport,
    latam_only: latamOnly,
    fixtures_total: fixtures.length,
    fixtures_uncovered_free: uncoveredForFree.length,
    fixtures_uncovered_vip: uncoveredForVip.length,
  };
}

module.exports = {
  runPredictionPipeline,
};
