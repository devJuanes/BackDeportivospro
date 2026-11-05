/**
 * Limpia marcadores imposibles en abetlive (leak cross-sport).
 * Uso: node src/scripts/clearBadLiveScores.js
 */
require("dotenv").config();
const { db } = require("../config/database");
const { isPlausibleScore } = require("../utils/liveScoreMatch");
const logger = require("../utils/logger");

async function main() {
  // Incluye tips ya cerrados: el leak pudo quedar guardado.
  const { data, error } = await db
    .from("abetlive")
    .select("id,sport,home_goals,away_goals,minute,state,home_team_name,away_team_name,match_date")
    .order("created_at", { ascending: false })
    .limit(800);

  if (error) throw new Error(error.message);

  let cleared = 0;
  for (const row of data || []) {
    const hg = Number(row.home_goals) || 0;
    const ag = Number(row.away_goals) || 0;
    const m = Number(row.minute) || 0;
    if (!hg && !ag && !m) continue;
    if (isPlausibleScore(row.sport, hg, ag, m)) continue;

    const { error: upErr } = await db
      .from("abetlive")
      .eq("id", row.id)
      .update({
        home_goals: 0,
        away_goals: 0,
        minute: 0,
        updated_at: new Date().toISOString(),
      });
    if (upErr) {
      logger.warn(`clear ${row.id}: ${upErr.message}`);
      continue;
    }
    cleared += 1;
    logger.info(
      `cleared ${row.id} ${row.home_team_name} vs ${row.away_team_name} was ${hg}:${ag} @${m}' sport=${row.sport}`
    );
  }
  console.log(`DONE cleared=${cleared}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
