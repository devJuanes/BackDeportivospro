/**
 * Borra noticias (sports_news + news_articles) para empezar feed propio.
 * Uso: node src/scripts/wipeNews.js --confirm=WIPE_NEWS
 */
require("dotenv").config();
const { executeRawSql } = require("../config/database");

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
  if (!process.argv.includes("--confirm=WIPE_NEWS")) {
    console.error("Uso: node src/scripts/wipeNews.js --confirm=WIPE_NEWS");
    process.exit(1);
  }
  const tables = ["sports_news", "news_articles"];
  const results = [];
  for (const t of tables) results.push(await wipe(t));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
