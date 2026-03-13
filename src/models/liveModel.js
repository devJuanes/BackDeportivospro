const { db } = require("../config/database");

async function getLivePredictions(limit = 100, filters = {}) {
  let query = db.from("abetlive").select("*");
  if (filters.sport) {
    query = query.eq("sport", filters.sport);
  }
  if (filters.sinceIso) {
    query = query.gte("created_at", filters.sinceIso);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    throw new Error(error.message || "Error obteniendo pronósticos live");
  }
  return data || [];
}

async function createLivePrediction(payload) {
  const { data, error } = await db.from("abetlive").insert({
    sport: payload.sport,
    league: payload.league,
    home_team_name: payload.homeTeam?.name || payload.home_team_name,
    away_team_name: payload.awayTeam?.name || payload.away_team_name,
    minute: payload.minute,
    prediction: payload.prediction,
    confidence: payload.confidence,
    odds: payload.odds,
  });
  if (error) {
    throw new Error(error.message || "Error creando pronóstico live");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function existsRecentLivePrediction(payload, sinceIso) {
  const { data, error } = await db
    .from("abetlive")
    .select("*")
    .eq("sport", payload.sport)
    .eq("home_team_name", payload.home_team_name)
    .eq("away_team_name", payload.away_team_name)
    .eq("prediction", payload.prediction)
    .gte("created_at", sinceIso)
    .limit(1);

  if (error) {
    throw new Error(error.message || "Error validando duplicado live");
  }
  return Boolean(data?.[0]);
}

module.exports = {
  getLivePredictions,
  createLivePrediction,
  existsRecentLivePrediction,
};
