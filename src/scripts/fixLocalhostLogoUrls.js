/**
 * Reescribe logos con localhost → URL pública del API.
 * Uso: node src/scripts/fixLocalhostLogoUrls.js
 */
require("dotenv").config();
const { db } = require("../config/database");
const { getPublicBaseUrl } = require("../services/futboolLogoService");

const TABLES = [
  process.env.FACTORY_PROD_FREE_TABLE || "abet",
  process.env.FACTORY_PROD_VIP_TABLE || "abetvip",
  "abetlive",
];

function rewriteUrl(url) {
  const s = String(url || "");
  if (!s) return "";
  if (!/localhost|127\.0\.0\.1/i.test(s)) return s;
  const base = getPublicBaseUrl();
  return s
    .replace(/^https?:\/\/localhost:\d+/i, base)
    .replace(/^https?:\/\/127\.0\.0\.1:\d+/i, base);
}

async function fixTable(table) {
  const { data, error } = await db.from(table).select("id,home_team_logo,away_team_logo").limit(2000);
  if (error) throw new Error(`${table}: ${error.message}`);
  let updated = 0;
  for (const row of data || []) {
    const home = rewriteUrl(row.home_team_logo);
    const away = rewriteUrl(row.away_team_logo);
    if (home === (row.home_team_logo || "") && away === (row.away_team_logo || "")) continue;
    const patch = {
      home_team_logo: home,
      away_team_logo: away,
      updated_at: new Date().toISOString(),
    };
    const u = await db.from(table).eq("id", row.id).update(patch);
    if (!u.error) updated += 1;
  }
  return updated;
}

async function main() {
  console.log("PUBLIC_BASE_URL →", getPublicBaseUrl());
  const results = {};
  for (const table of TABLES) {
    results[table] = await fixTable(table);
    console.log(`${table}: updated=${results[table]}`);
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
