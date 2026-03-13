const cron = require("node-cron");
const logger = require("../utils/logger");
const { monitorLiveMatches } = require("./liveMonitor");
const { collectAndStoreSportsNews } = require("../services/newsService");
const { runFactoryCycleNow } = require("../services/factoryService");

function startCronJobs() {
  if (process.env.ENABLE_CRON !== "true") {
    logger.info("Cron jobs deshabilitados por configuración.");
    return;
  }

  // Fábrica continua: ciclo completo con lock anti-solape.
  cron.schedule("*/5 * * * *", async () => {
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

  logger.info("Cron jobs activos.");
}

module.exports = {
  startCronJobs,
};
