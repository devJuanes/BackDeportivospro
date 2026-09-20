/**
 * Borra TODOS los pronósticos (cola + planta + live + tracking jobs relacionados).
 *
 * Uso:
 *   node src/scripts/wipePredictions.js --confirm=WIPE_PREDICTIONS
 */
require("dotenv").config();
const { executeRawSql } = require("../config/database");

const TABLES = [
  "abet",
  "abetvip",
  "abetlive",
  "free_picks",
  "vip_picks",
  "dp_predictions",
  "dp_tracking_jobs",
];

async function wipe(table) {
  try {
    await executeRawSql(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    return { table, ok: true, method: "truncate" };
  } catch (e1) {
    try {
      await executeRawSql(`DELETE FROM ${table}`);
      return { table, ok: true, method: "delete" };
    } catch (e2) {
      return { table, ok: false, error: e2.message || e1.message };
    }
  }
}

async function main() {
  if (!process.argv.includes("--confirm=WIPE_PREDICTIONS")) {
    console.error("Uso: node src/scripts/wipePredictions.js --confirm=WIPE_PREDICTIONS");
    process.exit(1);
  }
  console.log(`[wipe-predictions] Tablas: ${TABLES.join(", ")}`);
  const results = [];
  for (const t of TABLES) {
    const r = await wipe(t);
    results.push(r);
    console.log(r.ok ? `  OK  ${t} (${r.method})` : `  SKIP ${t}: ${r.error}`);
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
