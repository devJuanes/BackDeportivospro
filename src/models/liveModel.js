const { db } = require("../config/database");
const { scrubPlayStoreText } = require("../utils/playStoreSafe");
const { formatDateInTimezone, normalizeMatchDate } = require("../utils/helpers");
const { normalizePickLabel } = require("../utils/predictionDedupe");

function factoryTimezone() {
  return process.env.FACTORY_TIMEZONE || "America/Bogota";
}

function todayLiveDate() {
  return formatDateInTimezone(new Date(), factoryTimezone());
}

function rowMatchDate(row) {
  const fromCol = normalizeMatchDate(row?.match_date, factoryTimezone());
  if (fromCol) return fromCol;
  if (row?.created_at) {
    return formatDateInTimezone(new Date(row.created_at), factoryTimezone());
  }
  return null;
}

function isLiveState(state) {
  const s = String(state || "live").toLowerCase();
  return s === "live" || s === "inplay" || s === "in_play";
}

async function getLivePredictions(limit = 100, filters = {}) {
  const todayOnly = filters.todayOnly !== false;
  const liveOnly = filters.liveOnly !== false;
  const today = filters.matchDate || todayLiveDate();

  let query = db.from("abetlive").select("*");
  if (filters.sport) {
    query = query.eq("sport", filters.sport);
  }
  if (filters.sinceIso) {
    query = query.gte("created_at", filters.sinceIso);
  }
  if (liveOnly) {
    query = query.eq("state", "live");
  }
  if (todayOnly && !filters.sinceIso) {
    query = query.eq("match_date", today);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(Math.min(limit * 3, 400));
  if (error) {
    // Columnas nuevas pueden faltar en BD sin migrar: fallback sin filtros de state/date.
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("match_date") || msg.includes("state") || msg.includes("column")) {
      const fallback = await db
        .from("abetlive")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(Math.min(limit * 3, 400));
      if (fallback.error) {
        throw new Error(fallback.error.message || "Error obteniendo pronósticos live");
      }
      let rows = fallback.data || [];
      if (liveOnly) {
        rows = rows.filter((r) => isLiveState(r.state) && r.live_ended !== true);
      }
      if (todayOnly) {
        rows = rows.filter((r) => rowMatchDate(r) === today);
      }
      if (filters.sport) {
        rows = rows.filter((r) => String(r.sport || "") === String(filters.sport));
      }
      if (filters.sinceIso) {
        const since = new Date(filters.sinceIso).getTime();
        rows = rows.filter((r) => new Date(r.created_at).getTime() >= since);
      }
      return rows.slice(0, limit);
    }
    throw new Error(error.message || "Error obteniendo pronósticos live");
  }

  let rows = data || [];
  if (todayOnly) {
    rows = rows.filter((r) => {
      const d = rowMatchDate(r);
      return !d || d === today;
    });
  }
  if (liveOnly) {
    rows = rows.filter((r) => isLiveState(r.state) && r.live_ended !== true);
  }
  return rows.slice(0, limit);
}

async function createLivePrediction(payload) {
  const matchDate =
    normalizeMatchDate(payload.match_date || payload.date, factoryTimezone()) || todayLiveDate();
  const row = {
    sport: payload.sport,
    league: payload.league,
    home_team_name: payload.homeTeam?.name || payload.home_team_name,
    away_team_name: payload.awayTeam?.name || payload.away_team_name,
    minute: payload.minute,
    prediction: scrubPlayStoreText(payload.prediction),
    confidence: payload.confidence,
    odds: payload.odds,
    match_date: matchDate,
    state: payload.state || "live",
    live_ended: false,
    home_goals: Number(payload.home_goals ?? payload.homeGoals) || 0,
    away_goals: Number(payload.away_goals ?? payload.awayGoals) || 0,
  };
  if (payload.ai_rationale) {
    row.ai_rationale = scrubPlayStoreText(payload.ai_rationale);
  }
  if (payload.prediction_id) {
    row.prediction_id = payload.prediction_id;
  }

  let { data, error } = await db.from("abetlive").insert(row);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("match_date") || msg.includes("live_ended") || msg.includes("home_goals") || msg.includes("column")) {
      const legacy = {
        sport: row.sport,
        league: row.league,
        home_team_name: row.home_team_name,
        away_team_name: row.away_team_name,
        minute: row.minute,
        prediction: row.prediction,
        confidence: row.confidence,
        odds: row.odds,
        state: row.state,
      };
      if (row.ai_rationale) legacy.ai_rationale = row.ai_rationale;
      const retry = await db.from("abetlive").insert(legacy);
      data = retry.data;
      error = retry.error;
    }
  }
  if (error) {
    throw new Error(error.message || "Error creando pronóstico live");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function existsRecentLivePrediction(payload, sinceIso) {
  const { data, error } = await db
    .from("abetlive")
    .select("prediction,state,live_ended")
    .eq("sport", payload.sport)
    .eq("home_team_name", payload.home_team_name)
    .eq("away_team_name", payload.away_team_name)
    .gte("created_at", sinceIso)
    .limit(40);

  if (error) {
    throw new Error(error.message || "Error validando duplicado live");
  }
  const target = normalizePickLabel(payload.prediction);
  return Boolean(
    data?.some(
      (row) =>
        isLiveState(row.state) &&
        row.live_ended !== true &&
        normalizePickLabel(row.prediction) === target
    )
  );
}

async function getActiveLiveRows(limit = 120) {
  const today = todayLiveDate();
  let { data, error } = await db
    .from("abetlive")
    .select("*")
    .eq("state", "live")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    const fallback = await db.from("abetlive").select("*").order("created_at", { ascending: false }).limit(limit);
    data = fallback.data;
    error = fallback.error;
  }
  if (error) {
    throw new Error(error.message || "Error listando live activos");
  }

  return (data || []).filter((row) => {
    if (row.live_ended === true) return false;
    if (!isLiveState(row.state)) return false;
    return true;
  });
}

/**
 * Cierra una señal live: deja de aparecer en el feed "en vivo".
 * outcome: won | lost | pending | null
 */
async function finalizeLivePrediction(id, { outcome = "pending", state = "ended", minute, home_goals, away_goals } = {}) {
  const nowIso = new Date().toISOString();
  const patch = {
    state,
    live_ended: true,
    updated_at: nowIso,
  };
  if (outcome != null) patch.outcome = outcome;
  if (minute != null) patch.minute = Number(minute) || 0;
  if (home_goals != null) patch.home_goals = Number(home_goals) || 0;
  if (away_goals != null) patch.away_goals = Number(away_goals) || 0;

  let { error } = await db.from("abetlive").update(patch).eq("id", id);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("live_ended") || msg.includes("home_goals") || msg.includes("column")) {
      const slim = { state, updated_at: nowIso };
      if (outcome != null) slim.outcome = outcome;
      if (minute != null) slim.minute = Number(minute) || 0;
      const retry = await db.from("abetlive").update(slim).eq("id", id);
      error = retry.error;
    }
  }
  if (error) {
    throw new Error(error.message || "Error finalizando live");
  }
  return { id, ...patch };
}

async function updateLiveScore(id, patchIn = {}) {
  const patch = {
    updated_at: new Date().toISOString(),
  };
  if (patchIn.minute != null) patch.minute = Number(patchIn.minute) || 0;
  if (patchIn.home_goals != null) patch.home_goals = Number(patchIn.home_goals) || 0;
  if (patchIn.away_goals != null) patch.away_goals = Number(patchIn.away_goals) || 0;
  if (patchIn.state) patch.state = patchIn.state;

  const { error } = await db.from("abetlive").update(patch).eq("id", id);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("home_goals") || msg.includes("column")) {
      const slim = { updated_at: patch.updated_at };
      if (patch.minute != null) slim.minute = patch.minute;
      if (patch.state) slim.state = patch.state;
      await db.from("abetlive").update(slim).eq("id", id);
      return;
    }
    throw new Error(error.message || "Error actualizando marcador live");
  }
}

/** Marca filas live como ended si el partido ya no figura en la fuente en vivo. */
async function reconcileStaleLivePredictions(activePairKeys, sinceIso) {
  const keys = activePairKeys instanceof Set ? activePairKeys : new Set(activePairKeys);
  let query = db
    .from("abetlive")
    .select("id,home_team_name,away_team_name,state,match_date,created_at,live_ended")
    .gte("created_at", sinceIso);
  let { data, error } = await query;

  if (error?.message?.toLowerCase().includes("state") || error?.message?.toLowerCase().includes("match_date")) {
    const fallback = await db
      .from("abetlive")
      .select("id,home_team_name,away_team_name,created_at")
      .gte("created_at", sinceIso);
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    throw new Error(error.message || "Error reconciliando live");
  }
  for (const row of data || []) {
    if (!row.id || row.live_ended === true || String(row.state || "").toLowerCase() === "ended") continue;
    const k = `${row.home_team_name}|${row.away_team_name}`;
    if (!keys.has(k)) {
      await finalizeLivePrediction(row.id, { outcome: "pending", state: "ended" });
    }
  }
}

/**
 * Cualquier abetlive con state=live pero match_date/created_at anterior a hoy (Bogotá)
 * o live_ended implícito → finalizar.
 */
async function finalizeStaleLiveByCalendar(limit = 250) {
  const today = todayLiveDate();
  let { data, error } = await db
    .from("abetlive")
    .select("id,state,match_date,created_at,live_ended")
    .eq("state", "live")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    const fallback = await db.from("abetlive").select("id,state,created_at").order("created_at", { ascending: true }).limit(limit);
    data = (fallback.data || []).filter((r) => isLiveState(r.state));
    error = fallback.error;
  }
  if (error) {
    throw new Error(error.message || "Error limpiando live obsoletos");
  }

  let closed = 0;
  for (const row of data || []) {
    if (row.live_ended === true) {
      await finalizeLivePrediction(row.id, { outcome: row.outcome || "pending", state: "ended" });
      closed += 1;
      continue;
    }
    const d = rowMatchDate(row);
    if (d && d < today) {
      await finalizeLivePrediction(row.id, { outcome: "pending", state: "ended" });
      closed += 1;
    }
  }
  return { closed, today };
}

module.exports = {
  getLivePredictions,
  createLivePrediction,
  existsRecentLivePrediction,
  reconcileStaleLivePredictions,
  getActiveLiveRows,
  finalizeLivePrediction,
  updateLiveScore,
  finalizeStaleLiveByCalendar,
  todayLiveDate,
  rowMatchDate,
  isLiveState,
};
