const {
  createLivePrediction,
  existsRecentLivePrediction,
  reconcileStaleLivePredictions,
} = require("../models/liveModel");
const { generateLiveSuggestion } = require("../services/predictionEngine");
const { generateLiveInsightFromMatch } = require("../services/aiForecastService");
const { getLiveMatchesBySport, getFactorySports } = require("../services/sportsService");
const { runLiveLifecycleOnce } = require("../services/liveSettlementService");
const { ensureLiveTrackingJob } = require("../models/dpPredictionModel");
const { liveSignalDedupeKey } = require("../utils/predictionDedupe");
const { enrichPickLogos } = require("../services/futboolLogoService");
const { notifyLiveTip } = require("../services/telegramService");
const { notifyLivePick } = require("../services/predictionNotifyService");
const { upsertFixtures } = require("../models/fixtureModel");
const logger = require("../utils/logger");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const recentAlerts = new Map();

const LIVE_ALERT_COOLDOWN_MS = Number.parseInt(process.env.LIVE_ALERT_COOLDOWN_MS || `${3 * 60 * 1000}`, 10);

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
  if (diffMs < Math.max(60000, LIVE_ALERT_COOLDOWN_MS)) {
    return false;
  }
  recentAlerts.set(key, now);
  return true;
}

async function cacheLiveScoreboard(matches = []) {
  const rows = (matches || [])
    .filter((m) => m && (m.eventId || m.source_event_id))
    .map((m) => ({
      source: m.source || "espn_live",
      eventId: m.eventId || m.source_event_id,
      sport: m.sport || "football",
      league: m.league || "Live",
      match_date: m.match_date,
      match_hour: m.match_hour || "00:00",
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      status: m.status === "in" || m.status === "live" ? "in" : m.status || "in",
      minute: m.minute || 0,
      homeGoals: m.homeGoals || 0,
      awayGoals: m.awayGoals || 0,
    }));
  if (!rows.length) return 0;
  try {
    return await upsertFixtures(rows);
  } catch (error) {
    logger.warn(`[live] cache scoreboard: ${error.message}`);
    return 0;
  }
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

  await cacheLiveScoreboard(allLiveMatches);

  let lifecycle = { settled: 0, refreshed: 0, calendarClosed: 0 };
  try {
    lifecycle = await runLiveLifecycleOnce(allLiveMatches);
  } catch (error) {
    logger.warn(`Live lifecycle omitido: ${error.message}`);
  }

  const activePairKeys = new Set(allLiveMatches.map((m) => `${m.homeTeam}|${m.awayTeam}`));
  if (activePairKeys.size > 0) {
    const sinceReconcileIso = new Date(Date.now() - 14 * 3600 * 1000).toISOString();
    try {
      await reconcileStaleLivePredictions(activePairKeys, sinceReconcileIso);
    } catch (error) {
      logger.warn(`Reconcile live omitido: ${error.message}`);
    }
  }

  const aiLiveLimit = Number.parseInt(process.env.FACTORY_AI_LIVE_MATCH_LIMIT || "12", 10);
  const gapMs = Number.parseInt(process.env.FACTORY_AI_DELAY_MS || "1200", 10);
  let aiLiveCalls = 0;
  let created = 0;

  for (const match of allLiveMatches) {
    const heuristic = generateLiveSuggestion(match);
    if (!heuristic) continue;

    let suggestion = {
      ...heuristic,
      home_goals: match.homeGoals,
      away_goals: match.awayGoals,
      match_date: match.match_date,
    };
    if (aiLiveCalls < aiLiveLimit) {
      const refined = await generateLiveInsightFromMatch(match, heuristic);
      aiLiveCalls += 1;
      if (refined && refined.pick && !refined.invalid_context) {
        suggestion = {
          ...suggestion,
          prediction: refined.pick,
          confidence: refined.confidence,
          odds: refined.odds ?? heuristic.odds,
          ai_rationale: refined.analysis,
        };
      }
      if (gapMs > 0 && aiLiveCalls < aiLiveLimit) {
        await delay(gapMs);
      }
    }

    if (!shouldCreateAlert(suggestion)) continue;
    const sinceIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const duplicate = await existsRecentLivePrediction(suggestion, sinceIso);
    if (!duplicate) {
      enrichPickLogos(suggestion);
      const row = await createLivePrediction({
        ...suggestion,
        home_team_logo: suggestion.home_team_logo || "",
        away_team_logo: suggestion.away_team_logo || "",
      });
      created += 1;
      try {
        await notifyLiveTip(row || suggestion);
        await notifyLivePick(row || suggestion);
      } catch {
        /* opcional */
      }
      const liveId = row?.id;
      if (liveId) {
        try {
          await ensureLiveTrackingJob(liveId, row.prediction_id || null);
        } catch (error) {
          logger.warn(`Tracking live omitido (${liveId}): ${error.message}`);
        }
      }
    }
  }

  logger.info(
    `Live monitor: eventos=${allLiveMatches.length}, alertas=${created}, ia=${aiLiveCalls}, cerrados=${(lifecycle.settled || 0) + (lifecycle.calendarClosed || 0)}, refresh=${lifecycle.refreshed || 0}`
  );
  return created;
}

module.exports = {
  monitorLiveMatches,
};
