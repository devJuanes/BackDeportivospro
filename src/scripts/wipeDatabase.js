/**
 * Formatea / vacía tablas de contenido en MatuDB.
 * BORRA pronósticos, live, blogs/noticias, tracking, escalera, OTPs y usuarios.
 *
 * Uso (obligatorio confirmar):
 *   node src/scripts/wipeDatabase.js --confirm=WIPE
 *   node src/scripts/wipeDatabase.js --confirm=WIPE --keep-users
 *   node src/scripts/wipeDatabase.js --confirm=WIPE --only=predictions
 *
 * --only=predictions  → solo abet / abetvip / abetlive / free_picks / vip_picks / dp_predictions
 * --only=content      → predicciones + noticias/blog + fixtures + tracking + locks
 * --only=all          → content + usuarios + escalera + otps (default)
 * --keep-users        → no toca pf_users
 */
require("dotenv").config();
const { executeRawSql } = require("../config/database");
const logger = require("../utils/logger");

const PREDICTION_TABLES = [
  "abet",
  "abetvip",
  "abetlive",
  "free_picks",
  "vip_picks",
  "dp_predictions",
];

const CONTENT_TABLES = [
  ...PREDICTION_TABLES,
  "news_articles",
  "sports_news",
  "fixtures_cache",
  "dp_tracking_jobs",
  "factory_run_lock",
  "wompi_vip_redemptions",
];

const USER_TABLES = ["pf_email_otps", "pf_users"];

const LADDER_TABLES = [
  "ladder_recommendations",
  "ladder_events",
  "ladder_steps",
  "ladder_sessions",
];

function parseArgs() {
  const out = { confirm: "", only: "all", keepUsers: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--confirm=")) out.confirm = arg.slice(10).trim();
    if (arg.startsWith("--only=")) out.only = arg.slice(7).trim().toLowerCase();
    if (arg === "--keep-users") out.keepUsers = true;
  }
  return out;
}

function tablesForMode(only, keepUsers) {
  if (only === "predictions") return [...PREDICTION_TABLES];
  if (only === "content") return [...CONTENT_TABLES];
  const all = [...CONTENT_TABLES, ...LADDER_TABLES];
  if (!keepUsers) all.push(...USER_TABLES);
  else all.push("pf_email_otps");
  return all;
}

async function wipeTable(table) {
  // Prefer TRUNCATE; fallback DELETE if table missing / permission.
  try {
    await executeRawSql(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    return { table, ok: true, method: "truncate" };
  } catch (err) {
    const msg = String(err.message || "");
    try {
      await executeRawSql(`DELETE FROM ${table}`);
      return { table, ok: true, method: "delete" };
    } catch (err2) {
      return {
        table,
        ok: false,
        error: err2.message || msg,
      };
    }
  }
}

async function main() {
  const args = parseArgs();
  if (args.confirm !== "WIPE") {
    console.error(`
Refusa ejecutar sin confirmación.

  node src/scripts/wipeDatabase.js --confirm=WIPE
  node src/scripts/wipeDatabase.js --confirm=WIPE --keep-users
  node src/scripts/wipeDatabase.js --confirm=WIPE --only=predictions

Esto BORRA datos en MatuDB (proyecto de .env). No hay undo.
`);
    process.exit(1);
  }

  const tables = tablesForMode(args.only, args.keepUsers);
  logger.warn(`[wipe] Iniciando format mode=${args.only} tables=${tables.length}`);
  console.log(`[wipe] Tablas: ${tables.join(", ")}`);

  const results = [];
  for (const table of tables) {
    const r = await wipeTable(table);
    results.push(r);
    if (r.ok) {
      console.log(`  OK  ${table} (${r.method})`);
    } else {
      console.warn(`  SKIP ${table}: ${r.error}`);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ ok: true, wiped: ok, skipped: fail, results }, null, 2));
  logger.info(`[wipe] done wiped=${ok} skipped=${fail}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
