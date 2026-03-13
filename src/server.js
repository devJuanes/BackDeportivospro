require("dotenv").config();

const app = require("./app");
const logger = require("./utils/logger");
const { testConnection } = require("./config/database");
const { startCronJobs } = require("./jobs/cronJobs");
const { initWhatsApp } = require("./config/whatsapp");
const { runFactoryMigrations } = require("./database/migrateFactory");
const { syncDefaultSources } = require("./services/sourceService");

const port = Number.parseInt(process.env.PORT, 10) || 3000;

async function bootstrap() {
  try {
    await testConnection();
    await runFactoryMigrations();
    await syncDefaultSources();
  } catch (error) {
    logger.warn(`No se pudo validar DB al iniciar: ${error.message}`);
  }

  initWhatsApp();
  startCronJobs();

  app.listen(port, () => {
    logger.info(`Servidor ejecutándose en puerto ${port}`);
  });
}

bootstrap().catch((error) => {
  logger.error(`Error fatal al iniciar: ${error.message}`);
  process.exit(1);
});
