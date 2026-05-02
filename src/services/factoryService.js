const logger = require("../utils/logger");
const { runPredictionPipeline } = require("../jobs/scrapingJobs");
const { monitorLiveMatches } = require("../jobs/liveMonitor");
const { collectAndStoreSportsNews } = require("./newsService");
const { getFactorySports } = require("./sportsService");
const { getFreeSummaryToday } = require("../models/predictionModel");
const { getVipSummaryToday } = require("../models/vipModel");
const { getLivePredictions } = require("../models/liveModel");
const {
  getFactorySourcesStatus,
  refreshSourcesHealth,
  getPredictionSourcePolicy,
} = require("./sourceService");
const { getCurrentLiveSignals } = require("./liveSignalService");

const factoryState = {
  enabled: true,
  running: false,
  last_run_started_at: null,
  last_run_finished_at: null,
  last_run_error: null,
  last_run_result: null,
};

async function runFactoryCycleNow(options = {}) {
  const includeNews = options.includeNews === true;
  const force = options.force === true;
  if (!factoryState.enabled && !force) {
    return {
      skipped: true,
      reason: "factory_disabled",
      ...factoryState,
    };
  }
  if (factoryState.running) {
    return {
      skipped: true,
      reason: "factory_busy",
      ...factoryState,
    };
  }

  factoryState.running = true;
  factoryState.last_run_started_at = new Date().toISOString();
  factoryState.last_run_error = null;

  try {
    const sports = getFactorySports();
    const enableSourceHealth = process.env.FACTORY_ENABLE_EXTERNAL_SCRAPERS === "true";
    const matchDate =
      typeof options.matchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.matchDate.trim())
        ? options.matchDate.trim()
        : null;

    const [pipelineSettled, liveCount, news, sourceHealth] = await Promise.all([
      Promise.allSettled(sports.map((sport) => runPredictionPipeline({ sport, matchDate }))),
      monitorLiveMatches(),
      includeNews ? collectAndStoreSportsNews() : Promise.resolve([]),
      enableSourceHealth ? refreshSourcesHealth("football", 10) : Promise.resolve([]),
    ]);

    const pipelineBySport = pipelineSettled
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    const pipeline = pipelineBySport.reduce(
      (acc, current) => {
        acc.free += current.free;
        acc.vip += current.vip;
        acc.by_sport.push(current);
        return acc;
      },
      { free: 0, vip: 0, by_sport: [] }
    );

    factoryState.last_run_result = {
      pipeline,
      live_alerts_created: liveCount,
      news_stored: news.length,
      source_health_updated: sourceHealth.length,
    };
    factoryState.last_run_finished_at = new Date().toISOString();
    logger.info("Factory cycle ejecutado correctamente.");
    return {
      skipped: false,
      ...factoryState,
    };
  } catch (error) {
    factoryState.last_run_error = error.message;
    factoryState.last_run_finished_at = new Date().toISOString();
    logger.error(`Factory cycle falló: ${error.message}`);
    throw error;
  } finally {
    factoryState.running = false;
  }
}

function setFactoryEnabled(enabled) {
  factoryState.enabled = enabled === true;
  return {
    enabled: factoryState.enabled,
    running: factoryState.running,
  };
}

async function getFactoryStatus() {
  const sinceIso = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const [free, vip, liveHistory, liveCurrent, sources, sourcePolicy] = await Promise.all([
    getFreeSummaryToday(),
    getVipSummaryToday(),
    getLivePredictions(20, { sinceIso }),
    getCurrentLiveSignals({}),
    getFactorySourcesStatus("football"),
    getPredictionSourcePolicy("football"),
  ]);

  return {
    ...factoryState,
    free_today: free,
    vip_today: vip,
    live_recent_count: liveCurrent.length,
    live_history_recent_count: liveHistory.length,
    sources,
    source_policy: sourcePolicy,
  };
}

module.exports = {
  runFactoryCycleNow,
  getFactoryStatus,
  setFactoryEnabled,
};
