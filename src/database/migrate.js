const fs = require("node:fs/promises");
const path = require("node:path");
require("dotenv").config();
const { executeRawSql } = require("../config/database");
const logger = require("../utils/logger");

function splitSqlStatements(sql) {
  const cleaned = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigration() {
  const schemaPath = path.join(__dirname, "schema-deportivospro.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  const statements = splitSqlStatements(sql);

  let applied = 0;
  let skipped = 0;

  for (const statement of statements) {
    try {
      await executeRawSql(statement);
      applied += 1;
    } catch (error) {
      const msg = String(error.message || "");
      const isLegacy =
        statement.includes("FROM free_picks") ||
        statement.includes("FROM vip_picks");
      if (isLegacy) {
        skipped += 1;
        logger.warn(`Migración legacy omitida: ${msg}`);
        continue;
      }
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("does not exist")
      ) {
        skipped += 1;
        logger.warn(`Statement omitido: ${msg.slice(0, 120)}`);
        continue;
      }
      throw error;
    }
  }

  logger.info(`Migración DeportivosPro: ${applied} aplicados, ${skipped} omitidos.`);
  return { applied, skipped };
}

if (require.main === module) {
  runMigration()
    .then((r) => {
      console.log(`OK — ${r.applied} statements aplicados, ${r.skipped} omitidos.`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`Error en migración: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { runMigration, splitSqlStatements };
