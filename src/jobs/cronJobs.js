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
  // includeNews=true en el cron principal: integra también scraping de noticias del ciclo,
  // así no dependemos solo del run-now manual del admin.
  scheduleSafe(factoryCron, "*/15 * * * *", "factory", async () => {
    try {
      await runFactoryCycleNow({ includeNews: true });
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

  // Blog IA: previas del día. Cada 2h a los :15 (antes solo 3 veces al día y solo 4 artículos).
  // Configurable: BLOG_PREVIAS_CRON, BLOG_PREVIAS_MAX (default 12).
  const previasCron = process.env.BLOG_PREVIAS_CRON?.trim() || "15 */2 * * *";
  const previasMax = Number.parseInt(process.env.BLOG_PREVIAS_MAX || "12", 10);
  scheduleSafe(previasCron, "15 */2 * * *", "blog_previas", async () => {
    try {
      if (!isAiEnabled()) return;
      const r = await generatePreviaBlogsForDate(todayIsoDate(), previasMax);
      if (r.created > 0) logger.info(`[CRON] Blog previas: created=${r.created}/${previasMax}`);
    } catch (error) {
      logger.warn(`[CRON] Blog previas falló: ${error.message}`);
    }
  });

  // Blog IA: crónicas post-partido (picks cerrados sin recap). Cada hora a los :25 — más recaps por ciclo.
  const recapsMax = Number.parseInt(process.env.BLOG_RECAPS_MAX || "6", 10);
  cron.schedule("25 * * * *", async () => {
    try {
      if (!isAiEnabled()) return;
      const r = await generateRecapBlogsOnce(recapsMax);
      if (r.created > 0) logger.info(`[CRON] Blog recaps: created=${r.created}/${recapsMax}`);
    } catch (error) {
      logger.warn(`[CRON] Blog recaps falló: ${error.message}`);
    }
  });

  logger.info("Cron jobs activos.");
}

module.exports = {
  startCronJobs,
};
