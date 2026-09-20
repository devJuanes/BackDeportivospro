const { db } = require("../config/database");
const { normalizeMatchDate } = require("../utils/helpers");
const { normalizeMatchHour } = require("../utils/matchHour");
const { buildPredictionSeo } = require("../utils/predictionSeo");
const { inferTier } = require("../utils/predictionDto");
const { sortByKickoffAsc, todayMatchDate } = require("../utils/matchSchedule");
const { scrubPlayStoreText } = require("../utils/playStoreSafe");

const TABLE = process.env.DP_PREDICTIONS_TABLE || "dp_predictions";

async function getPredictions(limit = 100, filters = {}) {
  const targetDate = filters.date || todayMatchDate();
  let query = db.from(TABLE).select("*");

  if (filters.tier) {
    query = query.eq("tier", String(filters.tier).trim().toLowerCase());
  }
  if (filters.todayOnly) {
    query = query.eq("match_date", targetDate);
  }
  if (filters.sport) {
    query = query.eq("sport", String(filters.sport).trim().toLowerCase());
  }
  if (filters.published !== false) {
    query = query.eq("published", true);
  }
  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  const { data, error } = await query.limit(Math.min(limit * 3, 600));

  if (error) {
    throw new Error(error.message || "Error obteniendo pronósticos");
  }

  let rows = data || [];
  if (filters.todayOnly) {
    rows = rows.filter((row) => normalizeMatchDate(row.match_date) === targetDate);
  }
  return sortByKickoffAsc(rows).slice(0, limit);
}

async function getPredictionById(id) {
  const { data, error } = await db.from(TABLE).select("*").eq("id", id).limit(1);
  if (error) throw new Error(error.message || "Error obteniendo pronóstico");
  const row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

async function createPrediction(payload, baseTier = "free") {
  const tier = inferTier(payload, baseTier);
  const matchHour = normalizeMatchHour(payload.hours || payload.match_hour);
  const sport = String(payload.sport || "football").trim().toLowerCase() || "football";
  const home = payload.homeTeam?.name || payload.home_team_name || payload.team_a || "";
  const away = payload.awayTeam?.name || payload.away_team_name || payload.team_b || "";
  const prediction = scrubPlayStoreText(
    String(payload.prediction || payload.pick_text || "").trim()
  );
  const seo = buildPredictionSeo({ ...payload, tier, homeTeam: { name: home }, awayTeam: { name: away } });

  const row = {
    tier,
    sport,
    league: payload.league || "General",
    home_team: home,
    away_team: away,
    prediction,
    confidence: payload.confidence ?? null,
    odds: payload.odds ?? 0,
    probability: payload.probability ?? null,
    analysis: scrubPlayStoreText(
      payload.analysis || payload.rationale_short || payload.rationale || null
    ) || null,
    match_date: normalizeMatchDate(payload.date || payload.match_date) || todayMatchDate(),
    match_hour: matchHour,
    status: "pending",
    published: true,
    source: payload.source || "factory",
    seo_title: scrubPlayStoreText(seo.seo_title) || null,
    seo_description: scrubPlayStoreText(seo.seo_description) || null,
  };

  const { data, error } = await db.from(TABLE).insert(row);
  if (error) throw new Error(error.message || "Error creando pronóstico");
  return Array.isArray(data) ? data[0] : data;
}

async function updatePredictionState(id, state) {
  const { data, error } = await db.from(TABLE).eq("id", id).update({
    status: state,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message || "Error actualizando estado");
  return Array.isArray(data) ? data[0] : data;
}

async function updatePredictionLiveData(id, liveData) {
  const patch = {
    updated_at: new Date().toISOString(),
    ...liveData,
  };
  const { data, error } = await db.from(TABLE).eq("id", id).update(patch);
  if (error) throw new Error(error.message || "Error actualizando live data");
  return Array.isArray(data) ? data[0] : data;
}

async function getSummaryToday(tier) {
  const filters = { todayOnly: true };
  if (tier) filters.tier = tier;
  const rows = await getPredictions(500, filters);
  const summary = { total: rows.length, won: 0, lost: 0, pending: 0, live: 0 };
  for (const row of rows) {
    const s = String(row.status || "").toLowerCase();
    if (s === "won") summary.won += 1;
    else if (s === "lost") summary.lost += 1;
    else if (s === "live") summary.live += 1;
    else summary.pending += 1;
  }
  summary.hit_rate = summary.total
    ? Number(((summary.won / summary.total) * 100).toFixed(2))
    : 0;
  return summary;
}

async function followPrediction(predictionId, clientId) {
  const { data, error } = await db.from("dp_prediction_follows").insert({
    prediction_id: predictionId,
    client_id: clientId,
  });
  if (error) {
    if (String(error.message).toLowerCase().includes("duplicate")) {
      return { already: true };
    }
    throw new Error(error.message || "Error siguiendo pronóstico");
  }

  const pred = await getPredictionById(predictionId);
  if (pred) {
    await db.from(TABLE).eq("id", predictionId).update({
      follow_count: (Number(pred.follow_count) || 0) + 1,
      updated_at: new Date().toISOString(),
    });
  }

  await ensureTrackingJob(predictionId);

  return { followed: true, row: Array.isArray(data) ? data[0] : data };
}

async function unfollowPrediction(predictionId, clientId) {
  const { error } = await db
    .from("dp_prediction_follows")
    .eq("prediction_id", predictionId)
    .eq("client_id", clientId)
    .delete();
  if (error) throw new Error(error.message || "Error dejando de seguir");

  const pred = await getPredictionById(predictionId);
  if (pred && Number(pred.follow_count) > 0) {
    await db.from(TABLE).eq("id", predictionId).update({
      follow_count: Math.max(0, Number(pred.follow_count) - 1),
      updated_at: new Date().toISOString(),
    });
  }
  return { unfollowed: true };
}

async function getFollowedPredictions(clientId, limit = 50) {
  const { data: follows, error } = await db
    .from("dp_prediction_follows")
    .select("prediction_id")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message || "Error obteniendo follows");
  const ids = (follows || []).map((f) => f.prediction_id).filter(Boolean);
  if (!ids.length) return [];

  const rows = [];
  for (const id of ids) {
    const row = await getPredictionById(id);
    if (row) rows.push(row);
  }
  return sortByKickoffAsc(rows);
}

async function ensureTrackingJob(predictionId) {
  const { data: existing } = await db
    .from("dp_tracking_jobs")
    .select("id")
    .eq("prediction_id", predictionId)
    .eq("status", "active")
    .limit(1);

  if (existing?.length) return existing[0];

  const now = new Date();
  const next = new Date(now.getTime() + 120_000);
  const { data, error } = await db.from("dp_tracking_jobs").insert({
    prediction_id: predictionId,
    status: "active",
    next_check_at: next.toISOString(),
    check_interval_sec: 45,
  });
  if (error) throw new Error(error.message || "Error creando tracking job");
  return Array.isArray(data) ? data[0] : data;
}

/** Encola seguimiento de una fila abetlive (cron prediction_tracking + live_monitor). */
async function ensureLiveTrackingJob(abetliveId, predictionId = null) {
  if (!abetliveId) return null;

  let existingQuery = db
    .from("dp_tracking_jobs")
    .select("id")
    .eq("abetlive_id", abetliveId)
    .eq("status", "active")
    .limit(1);
  let { data: existing, error: existingErr } = await existingQuery;

  if (existingErr) {
    const msg = String(existingErr.message || "").toLowerCase();
    if (msg.includes("abetlive_id") || msg.includes("column")) {
      return null;
    }
  }
  if (existing?.length) return existing[0];

  const now = new Date();
  const next = new Date(now.getTime() + 90_000);
  const payload = {
    abetlive_id: abetliveId,
    status: "active",
    next_check_at: next.toISOString(),
    check_interval_sec: 30,
  };
  if (predictionId) payload.prediction_id = predictionId;

  const { data, error } = await db.from("dp_tracking_jobs").insert(payload);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("abetlive_id") || msg.includes("null") || msg.includes("prediction_id")) {
      return null;
    }
    throw new Error(error.message || "Error creando tracking job live");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function getActiveTrackingJobs(limit = 30) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("dp_tracking_jobs")
    .select("*")
    .eq("status", "active")
    .order("next_check_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message || "Error leyendo tracking jobs");
  return (data || []).filter((j) => !j.next_check_at || j.next_check_at <= now);
}

module.exports = {
  TABLE,
  getPredictions,
  getPredictionById,
  createPrediction,
  updatePredictionState,
  updatePredictionLiveData,
  getSummaryToday,
  followPrediction,
  unfollowPrediction,
  getFollowedPredictions,
  ensureTrackingJob,
  ensureLiveTrackingJob,
  getActiveTrackingJobs,
};
