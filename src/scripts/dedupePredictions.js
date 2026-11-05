/**
 * Borra pronósticos duplicados: mismo partido + mismo mercado, y deja
 * como máximo 2 mercados distintos por cruce.
 *
 * Uso:
 *   node src/scripts/dedupePredictions.js
 *   node src/scripts/dedupePredictions.js --date=2026-10-30
 *   node src/scripts/dedupePredictions.js --all
 */
require("dotenv").config();
const { db } = require("../config/database");
const { formatDateInTimezone } = require("../utils/helpers");
const {
  marketDedupeKey,
  fixtureTierDedupeKey,
} = require("../utils/predictionDedupe");
const {
  getMaxPicksPerMatch,
  marketFamily,
  pickLabel,
  isSettledPick,
} = require("../utils/pickVolume");
const logger = require("../utils/logger");

const TABLES = [
  process.env.DP_PREDICTIONS_TABLE || "dp_predictions",
  process.env.FACTORY_PROD_FREE_TABLE || "abet",
  process.env.FACTORY_PROD_VIP_TABLE || "abetvip",
  process.env.FACTORY_FREE_TABLE || "free_picks",
  process.env.FACTORY_VIP_TABLE || "vip_picks",
];

function todayIso() {
  return formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota");
}

function parseArgs() {
  const out = { date: null, all: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--all") out.all = true;
    if (arg.startsWith("--date=")) out.date = arg.slice(7).trim();
  }
  return out;
}

function rank(row) {
  let n = Number(row.confidence) || 0;
  if (isSettledPick(row)) n += 1000;
  const created = Date.parse(row.created_at || "") || 0;
  return n * 1e13 + (1e13 - created);
}

async function loadTable(table, matchDate) {
  let query = db.from(table).select("*").limit(800);
  if (matchDate) query = query.eq("match_date", matchDate);
  const { data, error } = await query;
  if (error) {
    logger.warn(`[dedupe] ${table} load: ${error.message}`);
    return [];
  }
  return data || [];
}

function idsToDrop(rows) {
  const max = getMaxPicksPerMatch();
  const keepIds = new Set();

  const byFixture = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const fk = fixtureTierDedupeKey(row);
    if (!fk) continue;
    if (!byFixture.has(fk)) byFixture.set(fk, []);
    byFixture.get(fk).push(row);
  }

  for (const group of byFixture.values()) {
    const settled = group.filter(isSettledPick);
    for (const s of settled) keepIds.add(s.id);

    const pending = group.filter((p) => !isSettledPick(p));
    const bestByMarket = new Map();
    for (const row of pending) {
      const mk = marketDedupeKey(row);
      if (!mk || mk.endsWith("|")) continue;
      const prev = bestByMarket.get(mk);
      if (!prev || rank(row) > rank(prev)) bestByMarket.set(mk, row);
    }

    const usedFam = new Set(settled.map((p) => marketFamily(pickLabel(p))));
    const slots = Math.max(0, max - settled.length);
    const ranked = [...bestByMarket.values()].sort((a, b) => rank(b) - rank(a));
    let taken = 0;
    for (const candidate of ranked) {
      if (taken >= slots) break;
      const fam = marketFamily(pickLabel(candidate));
      if (usedFam.has(fam)) continue;
      usedFam.add(fam);
      keepIds.add(candidate.id);
      taken += 1;
    }
  }

  return rows.filter((row) => row?.id && !isSettledPick(row) && !keepIds.has(row.id));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ error: { message: "timeout" } }), ms)),
  ]);
}

async function deleteIds(table, ids) {
  const chunkSize = 15;
  let removed = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    const results = await Promise.all(
      slice.map((id) => withTimeout(db.from(table).eq("id", id).delete(), 12000))
    );
    for (const r of results) {
      if (!r?.error) removed += 1;
    }
    logger.info(`[dedupe] ${table} ${Math.min(i + slice.length, ids.length)}/${ids.length} (-${removed})`);
  }
  return removed;
}

async function dedupeTable(table, matchDate) {
  let removed = 0;
  let scanned = 0;
  let lastKept = 0;
  for (let pass = 0; pass < 12; pass += 1) {
    const rows = await loadTable(table, matchDate);
    scanned = Math.max(scanned, rows.length);
    const drop = idsToDrop(rows);
    logger.info(`[dedupe] ${table} pass ${pass + 1}: scanned=${rows.length} drop=${drop.length}`);
    if (!drop.length) {
      lastKept = rows.length;
      break;
    }
    const passRemoved = await deleteIds(table, drop.map((r) => r.id));
    removed += passRemoved;
    lastKept = Math.max(0, rows.length - passRemoved);
    if (passRemoved === 0) break;
  }
  return { table, scanned, removed, kept: lastKept };
}

async function runDedupePredictions(options = {}) {
  const day =
    options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date) ? options.date : options.all ? null : todayIso();
  const results = [];
  for (const table of TABLES) {
    results.push(await dedupeTable(table, day));
  }
  return { date: day || "all", maxPerMatch: getMaxPicksPerMatch(), results };
}

async function main() {
  const args = parseArgs();
  const result = await runDedupePredictions({
    date: args.date,
    all: args.all,
  });
  logger.info(`[dedupe] ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`[dedupe] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runDedupePredictions };
