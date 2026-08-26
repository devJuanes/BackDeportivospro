require("dotenv").config();

const app = require("./app");
const logger = require("./utils/logger");
const { bootstrapDatabase, bootstrapFactoryInBackground } = require("./database/bootstrap");
const { startCronJobs } = require("./jobs/cronJobs");
const { initWhatsApp } = require("./config/whatsapp");

const port = Number.parseInt(process.env.PORT, 10) || 3000;

async function bootstrap() {
  try {
    await bootstrapDatabase();
  } catch (error) {
    logger.error(`Bootstrap DB falló: ${error.message}`);
    logger.error("Revisa MATUDB_URL, MATUDB_PROJECT_ID y MATUDB_API_KEY en .env");
    process.exit(1);
  }

  initWhatsApp();
  startCronJobs();

  app.listen(port, () => {
    logger.info(`Servidor ejecutándose en puerto ${port}`);
    bootstrapFactoryInBackground();
  });
}

bootstrap().catch((error) => {
  logger.error(`Error fatal al iniciar: ${error.message}`);
  process.exit(1);
});
