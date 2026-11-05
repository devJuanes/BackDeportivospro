/**
 * Repara tips degradados a pending cuando el marcador aún prueba won/lost.
 * NO borra filas. NO cambia schema.
 * Convención live: state=ended + outcome=won|lost (Flutter lee outcome).
 * Free/VIP: state=won|lost.
 *
 * Uso: node src/scripts/repairSettledOutcomes.js
 */
require("dotenv").config();
const { db } = require("../config/database");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
const { isPlausibleScore } = require("../utils/liveScoreMatch");
const logger = require("../utils/logger");

async function fetchChunks(table, queries) {
  const byId = new Map();
  for (const q of queries) {
    try {
      let builder = db.from(table).select("*").limit(q.limit || 500);
      if (q.eq) {
        for (const [k, v] of Object.entries(q.eq)) builder = builder.eq(k, v);
      }
      if (q.order) builder = builder.order(q.order.col, { ascending: !!q.order.asc });
      const { data, error } = await builder;
      if (error) {
        logger.warn(`repair fetch ${table}: ${error.message}`);
        continue;
      }
      for (const row of data || []) {
        if (row?.id) byId.set(row.id, row);
      }
    } catch (e) {
      logger.warn(`repair fetch ${table}: ${e.message}`);
    }
  }
  return [...byId.values()];
}

async function repairTable(table, { homeField, awayField, pickField, statusField, isLive }) {
  const rows = isLive
    ? await fetchChunks(table, [
        { eq: { state: "ended" }, limit: 600, order: { col: "updated_at", asc: false } },
        { eq: { outcome: "pending" }, limit: 600, order: { col: "updated_at", asc: false } },
        { eq: { live_ended: true }, limit: 400, order: { col: "created_at", asc: false } },
        { limit: 400, order: { col: "created_at", asc: false } },
      ])
    : await fetchChunks(table, [
        { eq: { state: "pending" }, limit: 500, order: { col: "updated_at", asc: false } },
        { limit: 400, order: { col: "created_at", asc: false } },
      ]);

  let fixed = 0;
  let skipped = 0;
  for (const row of rows) {
    const st = String(row[statusField] || "").toLowerCase();
    const out = String(row.outcome || "").toLowerCase();
    if (["won", "lost", "void", "ganada", "perdida"].includes(out)) {
      // Ya tiene outcome bueno; si live quedó state=won, normalizar a ended.
      if (isLive && (st === "won" || st === "lost" || st === "void")) {
        const patch = {
          state: out === "void" ? "void" : "ended",
          outcome: out,
          live_ended: true,
          updated_at: new Date().toISOString(),
        };
        const { error: upErr } = await db.from(table).eq("id", row.id).update(patch);
        if (!upErr) fixed += 1;
      }
      continue;
    }
    if (["won", "lost", "void", "ganada", "perdida"].includes(st) && !isLive) {
      continue;
    }

    const hg = Number(row.home_goals) || 0;
    const ag = Number(row.away_goals) || 0;
    const minute = Number(row.minute) || 0;
    if (!isPlausibleScore(row.sport || "football", hg, ag, minute || 90)) {
      skipped += 1;
      continue;
    }
    if (hg + ag === 0 && minute < 70 && st !== "ended" && row.live_ended !== true) {
      skipped += 1;
      continue;
    }

    const sport = String(row.sport || "football").toLowerCase();
    if (sport !== "football" && sport !== "soccer") {
      skipped += 1;
      continue;
    }

    const finished =
      minute >= 85 || st === "ended" || row.live_ended === true || hg + ag > 0;
    const result = evaluateFootballPickFromText(
      row[pickField],
      hg,
      ag,
      row[homeField],
      row[awayField],
      { matchFinished: finished }
    );
    if (result !== "won" && result !== "lost" && result !== "void") {
      skipped += 1;
      continue;
    }

    const patch = {
      updated_at: new Date().toISOString(),
    };
    if (isLive) {
      patch.state = result === "void" ? "void" : "ended";
      patch.outcome = result;
      patch.live_ended = true;
    } else {
      patch[statusField] = result;
    }
    const { error: upErr } = await db.from(table).eq("id", row.id).update(patch);
    if (upErr) {
      logger.warn(`repair ${table} ${row.id}: ${upErr.message}`);
      continue;
    }
    fixed += 1;
    logger.info(`repaired ${table} ${row.id} -> ${result} (${hg}:${ag})`);
  }
  return { table, sample: rows.length, fixed, skipped };
}

async function main() {
  const results = [];
  results.push(
    await repairTable("abetlive", {
      homeField: "home_team_name",
      awayField: "away_team_name",
      pickField: "prediction",
      statusField: "state",
      isLive: true,
    })
  );
  for (const t of ["abet", "abetvip"]) {
    try {
      results.push(
        await repairTable(t, {
          homeField: "home_team_name",
          awayField: "away_team_name",
          pickField: "prediction",
          statusField: "state",
          isLive: false,
        })
      );
    } catch (e) {
      results.push({ table: t, error: e.message });
    }
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
