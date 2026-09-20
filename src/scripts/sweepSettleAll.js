/**
 * Barrido completo: limpia spam corners, sync marcadores y early-settle.
 * Uso: node src/scripts/sweepSettleAll.js
 */
require("dotenv").config();
const { db } = require("../config/database");
const { settlePendingPickResultsOnce } = require("../services/pickSettlementService");
const { monitorLiveMatches } = require("../jobs/liveMonitor");
const { isCornersOrCardsMarket } = require("../utils/pickResultEvaluator");

async function pruneCornerSpam() {
  const { data, error } = await db
    .from("abetlive")
    .select("id,prediction,state")
    .in("state", ["live", "pending"])
    .limit(300);
  if (error) {
    console.warn(`[sweep] prune read: ${error.message}`);
    return 0;
  }
  let n = 0;
  const now = new Date().toISOString();
  for (const row of data || []) {
    if (!isCornersOrCardsMarket(row.prediction || "")) continue;
    const u = await db.from("abetlive").eq("id", row.id).update({
      state: "ended",
      live_ended: true,
      outcome: "void",
      updated_at: now,
    });
    if (!u.error) n += 1;
  }
  return n;
}

async function main() {
  console.log("[sweep] 0/3 prune corners/cards spam...");
  const pruned = await pruneCornerSpam();
  console.log(`[sweep] pruned=${pruned}`);

  console.log("[sweep] 1/3 live scoreboard + lifecycle...");
  try {
    const created = await monitorLiveMatches();
    console.log(`[sweep] live alerts created=${created}`);
  } catch (e) {
    console.warn(`[sweep] live: ${e.message}`);
  }

  console.log("[sweep] 2/3 settle all tables...");
  const r = await settlePendingPickResultsOnce();
  console.log(JSON.stringify({ ok: true, pruned, settle: r }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
