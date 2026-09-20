/**
 * Backfill post-deploy: logos, dedupe, liquidación de estados.
 * Uso: node src/scripts/backfillProduction.js [--date=YYYY-MM-DD] [--dedupe]
 */
require("dotenv").config();
const { db } = require("../config/database");
const { enrichPickLogos } = require("../services/futboolLogoService");
const { settlePendingPickResultsOnce } = require("../services/pickSettlementService");
const { productionDedupeKey } = require("../services/productionPublishService");
const { formatDateInTimezone } = require("../utils/helpers");
const logger = require("../utils/logger");

const FREE = process.env.FACTORY_PROD_FREE_TABLE || "abet";
const VIP = process.env.FACTORY_PROD_VIP_TABLE || "abetvip";

function parseArgs() {
  const out = { dedupe: false, date: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dedupe") out.dedupe = true;
    if (arg.startsWith("--date=")) out.date = arg.slice(7).trim();
  }
  return out;
}

async function backfillLogos(table, matchDate) {
  let query = db.from(table).select("*").limit(600);
  if (matchDate) query = query.eq("match_date", matchDate);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let updated = 0;
  for (const row of data || []) {
    const pick = {
      league: row.league,
      home_team_name: row.home_team_name,
      away_team_name: row.away_team_name,
      home_team_logo: row.home_team_logo || "",
      away_team_logo: row.away_team_logo || "",
    };
    enrichPickLogos(pick);
    const patch = {};
    if (pick.home_team_logo && !row.home_team_logo) patch.home_team_logo = pick.home_team_logo;
    if (pick.away_team_logo && !row.away_team_logo) patch.away_team_logo = pick.away_team_logo;
    if (!Object.keys(patch).length) continue;
    const u = await db.from(table).eq("id", row.id).update({ ...patch, updated_at: new Date().toISOString() });
    if (!u.error) updated += 1;
  }
  return updated;
}

async function dedupeTable(table, matchDate) {
  let query = db.from(table).select("id,home_team_name,away_team_name,prediction,match_date,confidence,created_at").limit(800);
  if (matchDate) query = query.eq("match_date", matchDate);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const seen = new Map();
  let removed = 0;
  for (const row of data || []) {
    const key = productionDedupeKey(row);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, row);
      continue;
    }
    const keep = (Number(row.confidence) || 0) >= (Number(prev.confidence) || 0) ? row : prev;
    const drop = keep.id === row.id ? prev : row;
    seen.set(key, keep);
    const d = await db.from(table).eq("id", drop.id).delete();
    if (!d.error) removed += 1;
  }
  return removed;
}

async function runBackfillProduction(options = {}) {
  const today = formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota");
  const day =
    options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date) ? options.date : today;
  const dedupe = options.dedupe !== false;

  const logosFree = await backfillLogos(FREE, day);
  const logosVip = await backfillLogos(VIP, day);

  let deduped = 0;
  if (dedupe) {
    deduped += await dedupeTable(FREE, day);
    deduped += await dedupeTable(VIP, day);
  }

  const settle = await settlePendingPickResultsOnce();

  return {
    date: day,
    logos: { free: logosFree, vip: logosVip },
    deduped,
    settled: settle.updated || 0,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runBackfillProduction({
    date: args.date,
    dedupe: args.dedupe,
  });
  logger.info(`[backfill] ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`[backfill] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runBackfillProduction };
