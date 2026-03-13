const fs = require("node:fs/promises");
const path = require("node:path");
const dotenv = require("dotenv");
const { executeRawSql } = require("../config/database");
const logger = require("../utils/logger");

dotenv.config();

async function run() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  await executeRawSql(sql);
  logger.info("Schema ejecutado correctamente.");
}

run().catch((error) => {
  logger.error(`Error ejecutando schema: ${error.message}`);
  process.exit(1);
});
