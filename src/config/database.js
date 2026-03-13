const { createClient } = require("@devjuanes/matuclient");
const logger = require("../utils/logger");

const matuUrl = process.env.MATUDB_URL;
const projectId = process.env.MATUDB_PROJECT_ID;
const apiKey = process.env.MATUDB_API_KEY;

if (!matuUrl || !projectId || !apiKey) {
  logger.warn(
    "Faltan variables MATUDB_URL / MATUDB_PROJECT_ID / MATUDB_API_KEY."
  );
}

const db = createClient({
  url: matuUrl || "http://localhost:3001",
  projectId: projectId || "default",
  apiKey: apiKey || "missing_api_key",
  useSupabase: process.env.MATUDB_USE_SUPABASE === "true",
});

function ensureConfigured() {
  if (!matuUrl || !projectId || !apiKey) {
    throw new Error("Configura MATUDB_URL, MATUDB_PROJECT_ID y MATUDB_API_KEY");
  }
}

async function testConnection() {
  ensureConfigured();
  const { data, error } = await db.rpc("SELECT NOW() AS now");
  if (error) {
    throw new Error(error.message || "No se pudo conectar a MatuDB");
  }
  logger.info(`MatuDB conectado correctamente.`);
  return true;
}

async function executeRawSql(sql) {
  ensureConfigured();
  const { data, error } = await db.rpc(sql);
  if (error) {
    throw new Error(error.message || "Error ejecutando SQL en MatuDB");
  }
  return data;
}

module.exports = { db, testConnection, executeRawSql };
