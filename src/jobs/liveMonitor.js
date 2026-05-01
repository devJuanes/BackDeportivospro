const {
  createLivePrediction,
  existsRecentLivePrediction,
  reconcileStaleLivePredictions,
} = require("../models/liveModel");
const { generateLiveSuggestion } = require("../services/predictionEngine");
const { generateLiveInsightFromMatch } = require("../services/aiForecastService");
const { getLiveMatchesBySport, getFactorySports } = require("../services/sportsService");
const { liveSignalDedupeKey } = require("../utils/predictionDedupe");
const logger = require("../utils/logger");

const recentAlerts = new Map();

function shouldCreateAlert(alert) {
  const key = liveSignalDedupeKey(
    alert.sport,
    alert.home_team_name,
    alert.away_team_name,
    alert.prediction
  );
  const now = Date.now();
  const lastTs = recentAlerts.get(key) || 0;
  const diffMs = now - lastTs;
  if (diffMs < 12 * 60 * 1000) {
    return false;
  }
  recentAlerts.set(key, now);
  return true;
}

async function monitorLiveMatches() {
  const sports = getFactorySports();

  const allLiveMatches = [];
  for (const sport of sports) {
    try {
      const rows = await getLiveMatchesBySport(sport);
      allLiveMatches.push(...rows);
    } catch (error) {
      logger.warn(`No se pudieron leer vivos para ${sport}: ${error.message}`);
    }
  }

  const activePairKeys = new Set(
    allLiveMatches.map((m) => `${m.homeTeam}|${m.awayTeam}`)
  );
  const sinceReconcileIso = new Date(Date.now() - 14 * 3600 * 1000).toISOString();
  try {
    await reconcileStaleLivePredictions(activePairKeys, sinceReconcileIso);
  } catch (error) {
    logger.warn(`Reconcile live omitido: ${error.message}`);
  }

  const aiLiveLimit = Number.parseInt(process.env.FACTORY_AI_LIVE_MATCH_LIMIT || "5", 10);
  let aiLiveCalls = 0;
  let created = 0;

  for (const match of allLiveMatches) {
    const heuristic = generateLiveSuggestion(match);
    if (!heuristic) {
      continue;
    }

    let suggestion = { ...heuristic };
    if (aiLiveCalls < aiLiveLimit) {
      const refined = await generateLiveInsightFromMatch(match, heuristic);
      aiLiveCalls += 1;
      if (refined && refined.pick && !refined.invalid_context) {
        suggestion = {
          ...heuristic,
          prediction: refined.pick,
          confidence: refined.confidence,
          odds: refined.odds ?? heuristic.odds,
          ai_rationale: refined.analysis,
        };
      }
    }

    if (!shouldCreateAlert(suggestion)) {
      continue;
    }
    const sinceIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const duplicate = await existsRecentLivePrediction(suggestion, sinceIso);
    if (!duplicate) {
      await createLivePrediction(suggestion);
      created += 1;
    }
  }

  logger.info(
    `Live monitor ejecutado. Eventos live=${allLiveMatches.length}, alertas=${created}, llamadas_ia_live=${aiLiveCalls}`
  );
  return created;
}

module.exports = {
  monitorLiveMatches,
};
