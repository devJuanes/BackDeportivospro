const logger = require("../utils/logger");
const { testConnection } = require("../config/database");
const { runMigration } = require("./migrate");
const { runFactoryMigrations } = require("./migrateFactory");
const { syncDefaultSources } = require("../services/sourceService");
const { runFactoryCycleNow } = require("../services/factoryService");
const { getPredictions } = require("../models/dpPredictionModel");
const { todayMatchDate } = require("../utils/matchSchedule");

function envFlag(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  return String(raw).toLowerCase() === "true" || raw === "1";
}

async function runSchemaBootstrap() {
  if (!envFlag("DB_AUTO_MIGRATE", true)) {
    logger.info("DB_AUTO_MIGRATE=false — migración SQL omitida al arrancar.");
    return { migrated: false };
  }

  const main = await runMigration();
  await runFactoryMigrations();
  const sources = await syncDefaultSources();
  logger.info(`Bootstrap DB: schema OK (${main.applied} stmts), fuentes=${sources.length}`);
  return { migrated: true, ...main, sources: sources.length };
}

async function runFactoryBootstrap() {
  if (!envFlag("BOOTSTRAP_FACTORY_ON_START", true)) {
    logger.info("BOOTSTRAP_FACTORY_ON_START=false — fábrica al arrancar omitida.");
    return { skipped: true, reason: "disabled" };
  }

  const date = todayMatchDate();
  const existing = await getPredictions(5, { todayOnly: true, date });
  logger.info(
    `Bootstrap fábrica: ${existing.length} picks actuales para ${date}. Ejecutando pipeline…`
  );
  const result = await runFactoryCycleNow({
    matchDate: date,
    latamFootballOnly: false,
    includeNews: envFlag("BOOTSTRAP_INCLUDE_NEWS", false),
  });

  if (result.skipped) {
    logger.warn(`Bootstrap fábrica omitida: ${result.reason || "unknown"}`);
    return result;
  }

  const pipeline = result.last_run_result?.pipeline || {};
  logger.info(
    `Bootstrap fábrica OK: free=+${pipeline.free || 0} vip=+${pipeline.vip || 0} (${date})`
  );
  return { skipped: false, date, pipeline };
}

/**
 * Conecta, aplica schema y sincroniza fuentes. Bloquea el arranque si falla la conexión.
 */
async function bootstrapDatabase() {
  await testConnection();
  return runSchemaBootstrap();
}

/**
 * Carga picks del día si la tabla está vacía. No bloquea el servidor si falla.
 */
function bootstrapFactoryInBackground() {
  if (!envFlag("BOOTSTRAP_FACTORY_ON_START", true)) return;

  setImmediate(async () => {
    try {
      await runFactoryBootstrap();
    } catch (error) {
      logger.warn(`Bootstrap fábrica falló (el servidor sigue activo): ${error.message}`);
    }
  });
}

module.exports = {
  bootstrapDatabase,
  bootstrapFactoryInBackground,
  runSchemaBootstrap,
  runFactoryBootstrap,
};
