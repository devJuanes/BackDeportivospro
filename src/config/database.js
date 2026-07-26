const { createClient } = require("@devjuanes/matuclient");
const logger = require("../utils/logger");

/**
 * Acepta MATUDB_* (correcto en backend) o VITE_MATUDB_* (si se copió el .env del front).
 */
function envMatu(name) {
  const a = String(process.env[`MATUDB_${name}`] || "").trim();
  if (a) return a;
  return String(process.env[`VITE_MATUDB_${name}`] || "").trim();
}

function isJwt(value) {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ""));
}

const matuUrl = envMatu("URL");
const projectId = envMatu("PROJECT_ID");
const apiKey = envMatu("API_KEY");
const accessToken = envMatu("ACCESS_TOKEN");
const useSupabase =
  process.env.MATUDB_USE_SUPABASE === "true" ||
  process.env.VITE_MATUDB_USE_SUPABASE === "true";

function projectBearer() {
  if (accessToken && isJwt(accessToken)) return accessToken;
  if (apiKey && isJwt(apiKey)) return apiKey;
  return "";
}

if (!matuUrl || !projectId || !apiKey) {
  logger.warn(
    "Faltan variables MATUDB_URL / MATUDB_PROJECT_ID / MATUDB_API_KEY (también acepta VITE_MATUDB_*).",
  );
} else if (process.env.VITE_MATUDB_URL && !process.env.MATUDB_URL) {
  logger.warn(
    "Usando VITE_MATUDB_* del .env. Preferible renombrar a MATUDB_* en el backend.",
  );
} else if (!projectBearer()) {
  logger.warn(
    "MatuDB API exige Authorization Bearer JWT. Pon ANON JWT KEY (eyJ…) en MATUDB_API_KEY o un JWT en MATUDB_ACCESS_TOKEN. Las keys mb_… dan Invalid token.",
  );
}

/**
 * matuclient ≤2.2.3 no manda Authorization. MatuDB ≥1.0.45 lo exige (JWT, no mb_…).
 */
const matuBase = String(matuUrl || "").replace(/\/$/, "");
if (apiKey && typeof globalThis.fetch === "function") {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input.url === "string"
            ? input.url
            : "";
    const isMatu =
      (matuBase && href.startsWith(matuBase)) ||
      /\/api\/projects\/[^/]+\/(data|auth|sql|storage|query|keys)\b/.test(href);
    if (!isMatu) return nativeFetch(input, init);

    const headers = new Headers(init?.headers || undefined);
    if (input && typeof input === "object" && "headers" in input && input.headers) {
      new Headers(input.headers).forEach((value, key) => {
        if (!headers.has(key)) headers.set(key, value);
      });
    }
    if (!headers.has("apikey")) headers.set("apikey", apiKey);

    const bearer = projectBearer();
    if (!headers.has("Authorization") && bearer) {
      headers.set("Authorization", `Bearer ${bearer}`);
    }

    return nativeFetch(input, { ...init, headers });
  };
}

const db = createClient({
  url: matuUrl || "http://localhost:3001",
  projectId: projectId || "default",
  apiKey: apiKey || "missing_api_key",
  useSupabase,
});

function ensureConfigured() {
  if (!matuUrl || !projectId || !apiKey) {
    throw new Error("Configura MATUDB_URL, MATUDB_PROJECT_ID y MATUDB_API_KEY");
  }
  if (!projectBearer()) {
    throw new Error(
      "MatuDB exige JWT en Authorization. Actualiza MATUDB_API_KEY con ANON JWT KEY (eyJ…) o define MATUDB_ACCESS_TOKEN",
    );
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

module.exports = { db, testConnection, executeRawSql, envMatu, projectBearer, isJwt };
