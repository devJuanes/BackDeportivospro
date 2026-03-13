const { db } = require("../config/database");
const { formatDateInTimezone } = require("../utils/helpers");

function todayIsoDate() {
  return formatDateInTimezone(
    new Date(),
    process.env.FACTORY_TIMEZONE || "America/Bogota"
  );
}

async function getFreePredictions(limit = 100, filters = {}) {
  let query = db.from("abet").select("*");

  if (filters.todayOnly) {
    query = query.eq("match_date", filters.date || todayIsoDate());
  }
  if (filters.sport) {
    query = query.eq("sport", filters.sport);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Error obteniendo pronósticos gratis");
  }
  return data || [];
}

async function createFreePrediction(payload) {
  const { data, error } = await db.from("abet").insert({
    sport: payload.sport,
    league: payload.league,
    home_team_name: payload.homeTeam?.name || payload.home_team_name,
    home_team_logo: payload.homeTeam?.logo || payload.home_team_logo,
    away_team_name: payload.awayTeam?.name || payload.away_team_name,
    away_team_logo: payload.awayTeam?.logo || payload.away_team_logo,
    prediction: payload.prediction,
    confidence: payload.confidence,
    odds: payload.odds,
    match_date: payload.date || payload.match_date,
    match_hour: payload.hours || payload.match_hour,
    state: payload.state || "pendiente",
    rationale_short: payload.rationale_short || payload.rationale || "",
    source: payload.source || "pipeline",
  });

  if (error) {
    throw new Error(error.message || "Error creando pronóstico gratis");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function updateFreePredictionState(id, state) {
  const { data, error } = await db.from("abet").eq("id", id).update({ state });
  if (error) {
    throw new Error(error.message || "Error actualizando estado FREE");
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
    const state = String(row.state || "").toLowerCase();
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
  getFreeSummaryToday,
};
