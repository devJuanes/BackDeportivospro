const cron = require("node-cron");
const logger = require("../utils/logger");
const { monitorLiveMatches } = require("./liveMonitor");
const { collectAndStoreSportsNews } = require("../services/newsService");
const { runFactoryCycleNow } = require("../services/factoryService");
const { expireStaleVipSubscriptions } = require("../services/vipSubscriptionService");
const { generatePreviaBlogsForDate, generateRecapBlogsOnce, todayIsoDate } = require("../services/blogGenerationService");
const { isAiEnabled } = require("../services/aiForecastService");

function scheduleSafe(expression, fallback, label, task) {
  const expr = String(expression || "").trim() || fallback;
  try {
    cron.schedule(expr, task);
    logger.info(`[CRON] ${label}: ${expr}`);
    return true;
  } catch (error) {
    logger.warn(`[CRON] ${label}: expresión inválida "${expr}" (${error.message}). Uso fallback ${fallback}`);
    cron.schedule(fallback, task);
    logger.info(`[CRON] ${label}: ${fallback} (fallback)`);
    return false;
  }
}

function startCronJobs() {
  if (process.env.ENABLE_CRON !== "true") {
    logger.info("Cron jobs deshabilitados por configuración.");
    return;
  }

  const factoryCron = process.env.CRON_FACTORY_EXPRESSION?.trim() || "*/15 * * * *";
  const liveCron = process.env.CRON_LIVE_EXPRESSION?.trim() || "*/5 * * * *";
  const newsCron = process.env.CRON_NEWS_EXPRESSION?.trim() || "*/45 * * * *";

  // Fábrica: por defecto cada 15 min (VPS pequeño). Override CRON_FACTORY_EXPRESSION.
  scheduleSafe(factoryCron, "*/15 * * * *", "factory", async () => {
    try {
      await runFactoryCycleNow({ includeNews: false });
    } catch (error) {
      logger.warn(`[CRON] Factory cycle falló: ${error.message}`);
    }
  });

  scheduleSafe(liveCron, "*/5 * * * *", "live_monitor", async () => {
    try {
      await monitorLiveMatches();
    } catch (error) {
      logger.warn(`[CRON] Live monitor falló: ${error.message}`);
    }
  });

  scheduleSafe(newsCron, "*/45 * * * *", "news", async () => {
    try {
      await collectAndStoreSportsNews();
    } catch (error) {
      logger.warn(`[CRON] Noticias falló: ${error.message}`);
    }
  });

  // VIP con fecha de fin: bajar flag cuando venza.
  cron.schedule("5 * * * *", async () => {
    try {
      await expireStaleVipSubscriptions();
    } catch (error) {
      logger.warn(`[CRON] expire VIP falló: ${error.message}`);
    }
  });

  // Blog IA: previas del día (requiere FACTORY_AI_ENABLED + FACTORY_AI_API_KEY).
  cron.schedule("15 8,14,20 * * *", async () => {
    try {
      if (!isAiEnabled()) return;
      const r = await generatePreviaBlogsForDate(todayIsoDate(), 4);
      if (r.created > 0) logger.info(`[CRON] Blog previas: created=${r.created}`);
    } catch (error) {
      logger.warn(`[CRON] Blog previas falló: ${error.message}`);
    }
  });

  // Blog IA: crónicas post-partido (picks cerrados sin recap).
  cron.schedule("25 * * * *", async () => {
    try {
      if (!isAiEnabled()) return;
      const r = await generateRecapBlogsOnce(2);
      if (r.created > 0) logger.info(`[CRON] Blog recaps: created=${r.created}`);
    } catch (error) {
      logger.warn(`[CRON] Blog recaps falló: ${error.message}`);
    }
  });

  logger.info("Cron jobs activos.");
}

module.exports = {
  startCronJobs,
};
