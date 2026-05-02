const cron = require("node-cron");
const logger = require("../utils/logger");
const { monitorLiveMatches } = require("./liveMonitor");
const { collectAndStoreSportsNews } = require("../services/newsService");
const { runFactoryCycleNow } = require("../services/factoryService");
const { expireStaleVipSubscriptions } = require("../services/vipSubscriptionService");
const { generatePreviaBlogsForDate, generateRecapBlogsOnce, todayIsoDate } = require("../services/blogGenerationService");
const { isAiEnabled } = require("../services/aiForecastService");

function startCronJobs() {
  if (process.env.ENABLE_CRON !== "true") {
    logger.info("Cron jobs deshabilitados por configuración.");
    return;
  }

  // Fábrica continua: ciclo completo con lock anti-solape.
  cron.schedule("*/3 * * * *", async () => {
    try {
      await runFactoryCycleNow({ includeNews: false });
    } catch (error) {
      logger.warn(`[CRON] Factory cycle falló: ${error.message}`);
    }
  });

  // Monitor de vivo cada minuto.
  cron.schedule("* * * * *", async () => {
    try {
      await monitorLiveMatches();
    } catch (error) {
      logger.warn(`[CRON] Live monitor falló: ${error.message}`);
    }
  });

  // Noticias y contexto cada 30 minutos.
  cron.schedule("*/30 * * * *", async () => {
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
