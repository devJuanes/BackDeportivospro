const { db } = require("../config/database");
const { formatDateInTimezone } = require("../utils/helpers");
const { normalizeMatchHour } = require("../utils/matchHour");
const { buildPredictionSeo } = require("../utils/predictionSeo");
const FREE_TABLE = process.env.FACTORY_FREE_TABLE || "free_picks";

function todayIsoDate() {
  return formatDateInTimezone(
    new Date(),
    process.env.FACTORY_TIMEZONE || "America/Bogota"
  );
}

async function getFreePredictions(limit = 100, filters = {}) {
  let query = db.from(FREE_TABLE).select("*");

  if (filters.todayOnly) {
    query = query.eq("match_date", filters.date || todayIsoDate());
  }
  if (filters.moderationStatus) {
    query = query.eq("moderation_status", filters.moderationStatus);
  }
  if (filters.sport) {
    query = query.eq("sport", String(filters.sport).trim().toLowerCase());
  }

  let { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error?.message?.toLowerCase().includes("moderation_status")) {
    let fallbackQuery = db.from(FREE_TABLE).select("*");
    if (filters.todayOnly) {
      fallbackQuery = fallbackQuery.eq("match_date", filters.date || todayIsoDate());
    }
    if (filters.sport) {
      fallbackQuery = fallbackQuery.eq("sport", String(filters.sport).trim().toLowerCase());
    }
    const fallback = await fallbackQuery.order("created_at", { ascending: false }).limit(limit);
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    throw new Error(error.message || "Error obteniendo pronósticos gratis");
  }
  return data || [];
}

async function createFreePrediction(payload) {
  const matchHour = normalizeMatchHour(payload.hours || payload.match_hour);
  const sport = String(payload.sport || "football").trim().toLowerCase() || "football";
  const seo = buildPredictionSeo({ ...payload, tier: "free" });
  const { data, error } = await db.from(FREE_TABLE).insert({
    league: payload.league,
    team_a: payload.homeTeam?.name || payload.home_team_name,
    team_b: payload.awayTeam?.name || payload.away_team_name,
    pick_text: payload.prediction,
    confidence: payload.confidence,
    odds: payload.odds,
    probability: payload.probability || null,
    analysis: payload.analysis || payload.rationale_short || payload.rationale || null,
    match_date: payload.date || payload.match_date,
    match_hour: matchHour,
    sport,
    status: "pending",
    moderation_status: "pending",
    moderation_note: payload.moderation_note || null,
    seo_title: seo.seo_title || null,
    seo_description: seo.seo_description || null,
  });

  if (error) {
    throw new Error(error.message || "Error creando pronóstico gratis");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function updateFreePredictionState(id, state) {
  const { data, error } = await db.from(FREE_TABLE).eq("id", id).update({ status: state });
  if (error) {
    throw new Error(error.message || "Error actualizando estado FREE");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function updateFreeModerationStatus(id, moderationStatus, moderationNote = null) {
  const { data, error } = await db
    .from(FREE_TABLE)
    .eq("id", id)
    .update({ moderation_status: moderationStatus, moderation_note: moderationNote });
  if (error) {
    throw new Error(error.message || "Error actualizando aprobación FREE");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function getFreeSummaryToday() {
  const rows = await getFreePredictions(500, { todayOnly: true });
  const summary = {
    total: rows.length,
    won: 0,
    lost: 0,
    pending: 0,
  };

  for (const row of rows) {
    const state = String(row.status || "").toLowerCase();
    if (state === "ganada" || state === "won") summary.won += 1;
    else if (state === "perdida" || state === "lost") summary.lost += 1;
    else summary.pending += 1;
  }

  summary.hit_rate = summary.total
    ? Number(((summary.won / summary.total) * 100).toFixed(2))
    : 0;

  return summary;
}

module.exports = {
  getFreePredictions,
  createFreePrediction,
  updateFreePredictionState,
  updateFreeModerationStatus,
  getFreeSummaryToday,
};
