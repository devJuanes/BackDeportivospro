const { db } = require("../config/database");
const { formatDateInTimezone } = require("../utils/helpers");
const VIP_TABLE = process.env.FACTORY_VIP_TABLE || "vip_picks";

function todayIsoDate() {
  return formatDateInTimezone(
    new Date(),
    process.env.FACTORY_TIMEZONE || "America/Bogota"
  );
}

async function getVipPredictions(limit = 100, filters = {}) {
  let query = db.from(VIP_TABLE).select("*");
  if (filters.todayOnly) {
    query = query.eq("match_date", filters.date || todayIsoDate());
  }
  if (filters.moderationStatus) {
    query = query.eq("moderation_status", filters.moderationStatus);
  }

  let { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error?.message?.toLowerCase().includes("moderation_status")) {
    let fallbackQuery = db.from(VIP_TABLE).select("*");
    if (filters.todayOnly) {
      fallbackQuery = fallbackQuery.eq("match_date", filters.date || todayIsoDate());
    }
    const fallback = await fallbackQuery.order("created_at", { ascending: false }).limit(limit);
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    throw new Error(error.message || "Error obteniendo pronósticos VIP");
  }
  return data || [];
}

async function createVipPrediction(payload) {
  const { data, error } = await db.from(VIP_TABLE).insert({
    league: payload.league,
    team_a: payload.homeTeam?.name || payload.home_team_name,
    team_b: payload.awayTeam?.name || payload.away_team_name,
    pick_text: payload.prediction,
    confidence: payload.confidence,
    odds: payload.odds,
    probability: payload.probability || null,
    analysis: payload.analysis || payload.rationale_short || payload.rationale || null,
    match_date: payload.date || payload.match_date,
    status: "pending",
    moderation_status: "pending",
    moderation_note: payload.moderation_note || null,
    seo_title: payload.seo_title || null,
    seo_description: payload.seo_description || null,
  });

  if (error) {
    throw new Error(error.message || "Error creando pronóstico VIP");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function updateVipPredictionState(id, state) {
  const { data, error } = await db
    .from(VIP_TABLE)
    .eq("id", id)
    .update({ status: state });
  if (error) {
    throw new Error(error.message || "Error actualizando estado VIP");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function updateVipModerationStatus(id, moderationStatus, moderationNote = null) {
  const { data, error } = await db
    .from(VIP_TABLE)
    .eq("id", id)
    .update({ moderation_status: moderationStatus, moderation_note: moderationNote });
  if (error) {
    throw new Error(error.message || "Error actualizando aprobación VIP");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function getVipSummaryToday() {
  const rows = await getVipPredictions(500, { todayOnly: true });
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
  getVipPredictions,
  createVipPrediction,
  updateVipPredictionState,
  updateVipModerationStatus,
  getVipSummaryToday,
};
