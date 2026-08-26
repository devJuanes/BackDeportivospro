const { createClient } = require("@devjuanes/matuclient");
const logger = require("../utils/logger");

/**
 * Acepta MATUDB_* (correcto en backend) o VITE_MATUDB_* (si se copió el .env del front).
 * Formato de key: ver src/docs/matudb.md → anon_xxxx
 */
function envMatu(name) {
  const a = String(process.env[`MATUDB_${name}`] || "").trim();
  if (a) return a;
  return String(process.env[`VITE_MATUDB_${name}`] || "").trim();
}

function isJwt(value) {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function isAnonKey(value) {
  return /^anon_[A-Za-z0-9_]+/.test(String(value || ""));
}

function isLegacyMbKey(value) {
  return /^mb_[A-Za-z0-9]+/.test(String(value || ""));
}

const matuUrl = envMatu("URL");
const projectId = envMatu("PROJECT_ID");
const apiKey = envMatu("API_KEY");
const accessToken = envMatu("ACCESS_TOKEN");
const useSupabase =
  process.env.MATUDB_USE_SUPABASE === "true" ||
  process.env.VITE_MATUDB_USE_SUPABASE === "true";

function projectBearer() {
  // Solo JWT de sesión/auth en Authorization (como matuclient rpc).
  // mb_ y anon_ van solo en header apikey — Bearer con mb_ causa "Invalid token".
  if (accessToken && isJwt(accessToken)) return accessToken;
  if (apiKey && isJwt(apiKey)) return apiKey;
  return "";
}

function hasApiKey() {
  return Boolean(matuUrl && projectId && apiKey);
}

if (!matuUrl || !projectId || !apiKey) {
  logger.warn(
    "Faltan MATUDB_URL / MATUDB_PROJECT_ID / MATUDB_API_KEY. Ver src/docs/matudb.md",
  );
} else if (process.env.VITE_MATUDB_URL && !process.env.MATUDB_URL) {
  logger.warn("Usando VITE_MATUDB_* — renombra a MATUDB_* en el backend.");
} else if (isLegacyMbKey(apiKey)) {
  logger.info("MATUDB_API_KEY mb_… — usando solo header apikey (sin Bearer).");
} else if (!isAnonKey(apiKey) && !isJwt(apiKey) && !isLegacyMbKey(apiKey)) {
  logger.warn("MATUDB_API_KEY con formato desconocido. Ver src/docs/matudb.md");
}

/**
 * matuclient manda apikey; MatuDB cloud también usa Authorization Bearer (anon_ o JWT).
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

    const doFetch = () => nativeFetch(input, { ...init, headers });
    return doFetch().catch((err) => {
      const msg = String(err?.message || err || "");
      if (!msg.toLowerCase().includes("fetch failed")) throw err;
      return new Promise((r) => setTimeout(r, 400)).then(doFetch);
    });
  };
}

const db = createClient({
  url: matuUrl || "http://localhost:3001",
  projectId: projectId || "default",
  apiKey: apiKey || "missing_api_key",
  useSupabase,
});

function ensureConfigured() {
  if (!hasApiKey()) {
    throw new Error("Configura MATUDB_URL, MATUDB_PROJECT_ID y MATUDB_API_KEY (ver src/docs/matudb.md)");
  }
}

async function testConnection() {
  ensureConfigured();
  const { data, error } = await db.rpc("SELECT NOW() AS now");
  if (error) {
    throw new Error(error.message || "No se pudo conectar a MatuDB");
  }
  logger.info("MatuDB conectado correctamente.");
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

module.exports = {
  db,
  testConnection,
  executeRawSql,
  envMatu,
  projectBearer,
  isJwt,
  isAnonKey,
  isLegacyMbKey,
};
