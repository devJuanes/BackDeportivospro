/**
 * Diagnóstico rápido abetlive / abet en MatuDB.
 * Uso: node src/scripts/diagnoseSettlement.js
 */
require("dotenv").config();
const { db } = require("../config/database");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");

async function main() {
  const live = await db
    .from("abetlive")
    .select("id,state,outcome,prediction,home_goals,away_goals,minute,home_team_name,away_team_name,live_ended")
    .limit(120);
  const rows = live.data || [];
  const by = {};
  let earlyShouldWin = 0;
  const examples = [];
  for (const r of rows) {
    const s = String(r.state || "?");
    by[s] = (by[s] || 0) + 1;
    const hg = Number(r.home_goals) || 0;
    const ag = Number(r.away_goals) || 0;
    const ev = evaluateFootballPickFromText(
      r.prediction,
      hg,
      ag,
      r.home_team_name,
      r.away_team_name,
      { matchFinished: false }
    );
    if (ev === "won" && s !== "won") {
      earlyShouldWin += 1;
      if (examples.length < 10) {
        examples.push({
          pred: String(r.prediction || "").slice(0, 50),
          score: `${hg}-${ag}`,
          state: s,
          should: ev,
        });
      }
    }
  }
  console.log(JSON.stringify({ liveCount: rows.length, byState: by, earlyShouldWin, examples }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
