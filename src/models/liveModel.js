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
  const row = {
    sport: payload.sport,
    league: payload.league,
    home_team_name: payload.homeTeam?.name || payload.home_team_name,
    away_team_name: payload.awayTeam?.name || payload.away_team_name,
    minute: payload.minute,
    prediction: payload.prediction,
    confidence: payload.confidence,
    odds: payload.odds,
  };
  if (payload.ai_rationale) {
    row.ai_rationale = payload.ai_rationale;
  }
  if (payload.state) {
    row.state = payload.state;
  }
  const { data, error } = await db.from("abetlive").insert(row);
  if (error) {
    throw new Error(error.message || "Error creando pronóstico live");
  }
  return Array.isArray(data) ? data[0] : data;
}

const { normalizePickLabel } = require("../utils/predictionDedupe");

async function existsRecentLivePrediction(payload, sinceIso) {
  const { data, error } = await db
    .from("abetlive")
    .select("prediction")
    .eq("sport", payload.sport)
    .eq("home_team_name", payload.home_team_name)
    .eq("away_team_name", payload.away_team_name)
    .gte("created_at", sinceIso)
    .limit(40);

  if (error) {
    throw new Error(error.message || "Error validando duplicado live");
  }
  const target = normalizePickLabel(payload.prediction);
  return Boolean(data?.some((row) => normalizePickLabel(row.prediction) === target));
}

/** Marca filas live como ended si el partido ya no figura en la fuente en vivo. */
async function reconcileStaleLivePredictions(activePairKeys, sinceIso) {
  const keys = activePairKeys instanceof Set ? activePairKeys : new Set(activePairKeys);
  const { data, error } = await db
    .from("abetlive")
    .select("id,home_team_name,away_team_name,state")
    .gte("created_at", sinceIso);

  if (error) {
    throw new Error(error.message || "Error reconciliando live");
  }
  const nowIso = new Date().toISOString();
  for (const row of data || []) {
    if (!row.id || row.state === "ended") continue;
    const k = `${row.home_team_name}|${row.away_team_name}`;
    if (!keys.has(k)) {
      await db
        .from("abetlive")
        .update({ state: "ended", updated_at: nowIso })
        .eq("id", row.id);
    }
  }
}

module.exports = {
  getLivePredictions,
  createLivePrediction,
  existsRecentLivePrediction,
  reconcileStaleLivePredictions,
};
