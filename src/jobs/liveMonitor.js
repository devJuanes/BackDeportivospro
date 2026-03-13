const {
  createLivePrediction,
  existsRecentLivePrediction,
} = require("../models/liveModel");
const { generateLiveSuggestion } = require("../services/predictionEngine");
const { getLiveMatchesBySport } = require("../services/sportsService");
const logger = require("../utils/logger");

const recentAlerts = new Map();

function shouldCreateAlert(alert) {
  const key = `${alert.sport}|${alert.home_team_name}|${alert.away_team_name}|${alert.prediction}`;
  const now = Date.now();
  const lastTs = recentAlerts.get(key) || 0;
  const diffMs = now - lastTs;
  if (diffMs < 10 * 60 * 1000) {
    return false;
  }
  recentAlerts.set(key, now);
  return true;
}

async function monitorLiveMatches() {
  const sports = (process.env.FACTORY_SPORTS || "football")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allLiveMatches = [];
  for (const sport of sports) {
    try {
      const rows = await getLiveMatchesBySport(sport);
      allLiveMatches.push(...rows);
    } catch (error) {
      logger.warn(`No se pudieron leer vivos para ${sport}: ${error.message}`);
    }
  }

  let created = 0;
  for (const match of allLiveMatches) {
    const suggestion = generateLiveSuggestion(match);
    if (suggestion && shouldCreateAlert(suggestion)) {
      const sinceIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const duplicate = await existsRecentLivePrediction(suggestion, sinceIso);
      if (!duplicate) {
        await createLivePrediction(suggestion);
        created += 1;
      }
    }
  }

  logger.info(
    `Live monitor ejecutado. Eventos live=${allLiveMatches.length}, alertas=${created}`
  );
  return created;
}

module.exports = {
  monitorLiveMatches,
};
