const { db } = require("../config/database");
const { scrubPlayStoreText, stripCjkText } = require("../utils/playStoreSafe");
const { formatDateInTimezone, normalizeMatchDate } = require("../utils/helpers");
const { normalizePickLabel } = require("../utils/predictionDedupe");
const { sortByKickoffAsc } = require("../utils/matchSchedule");
const { preserveSettledOutcome, settledFromRow } = require("../utils/preserveSettledOutcome");

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
      return sortByKickoffAsc(rows).slice(0, limit);
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
  return sortByKickoffAsc(rows).slice(0, limit);
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
  if (payload.home_team_logo) row.home_team_logo = String(payload.home_team_logo);
  if (payload.away_team_logo) row.away_team_logo = String(payload.away_team_logo);

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
  // Incluye tips early-won/lost aún sin live_ended para seguir sync de marcador.
  let { data, error } = await db
    .from("abetlive")
    .select("*")
    .eq("match_date", today)
    .eq("live_ended", false)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    const fallback = await db
      .from("abetlive")
      .select("*")
      .eq("state", "live")
      .order("created_at", { ascending: false })
      .limit(limit);
    data = fallback.data;
    error = fallback.error;
  }
  if (error) {
    throw new Error(error.message || "Error listando live activos");
  }

  return (data || []).filter((row) => {
    if (row.live_ended === true) return false;
    const st = String(row.state || "").toLowerCase();
    return st === "live" || st === "won" || st === "lost" || st === "pending" || st === "void";
  });
}

/**
 * Tips ya cerrados del feed (ended / live_ended) pero SIN resultado won/lost.
 * El cron debe re-evaluarlos con el marcador; si no, quedan pending para siempre.
 */
async function getUnresolvedEndedLiveRows(limit = 250) {
  let { data, error } = await db
    .from("abetlive")
    .select("*")
    .eq("state", "ended")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    const fallback = await db
      .from("abetlive")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    data = fallback.data;
    error = fallback.error;
  }
  if (error) {
    throw new Error(error.message || "Error listando live sin liquidar");
  }

  return (data || []).filter((row) => {
    if (settledFromRow(row)) return false;
    const st = String(row.state || "").toLowerCase();
    const ended = st === "ended" || row.live_ended === true;
    if (!ended) return false;
    const hg = Number(row.home_goals) || 0;
    const ag = Number(row.away_goals) || 0;
    const minute = Number(row.minute) || 0;
    // Solo filas con marcador usable (evita spam de pending vacíos).
    return hg + ag > 0 || minute >= 70;
  });
}

/**
 * Cierra una señal live: deja de aparecer en el feed "en vivo".
 * Nunca degrada won/lost/void a pending.
 */
async function finalizeLivePrediction(id, { outcome = "pending", state = "ended", minute, home_goals, away_goals } = {}) {
  let current = null;
  try {
    const { data } = await db.from("abetlive").select("id,state,outcome,live_ended").eq("id", id).limit(1);
    current = Array.isArray(data) ? data[0] : data;
  } catch {
    /* ignore */
  }
  const preserved = preserveSettledOutcome(current || {}, outcome, state, { liveStyle: true });
  const nowIso = new Date().toISOString();
  const patch = {
    state: preserved.state,
    outcome: preserved.outcome,
    live_ended: true,
    updated_at: nowIso,
  };
  // Blindaje absoluto: jamás escribir pending si ya había resultado.
  if (preserved.locked && ["pending", "live", ""].includes(String(patch.outcome || "").toLowerCase())) {
    patch.outcome = preserved.outcome;
    patch.state = preserved.state;
  }
  if (minute != null) patch.minute = Number(minute) || 0;
  if (home_goals != null) patch.home_goals = Number(home_goals) || 0;
  if (away_goals != null) patch.away_goals = Number(away_goals) || 0;

  let { error } = await db.from("abetlive").eq("id", id).update(patch);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("live_ended") || msg.includes("home_goals") || msg.includes("column")) {
      const slim = {
        state: preserved.state,
        updated_at: nowIso,
      };
      if (preserved.outcome != null) slim.outcome = preserved.outcome;
      if (minute != null) slim.minute = Number(minute) || 0;
      const retry = await db.from("abetlive").eq("id", id).update(slim);
      error = retry.error;
    }
  }
  if (error) {
    throw new Error(error.message || "Error finalizando live");
  }
  return { id, ...patch };
}

function syncAnalysisScoreText(text, homeGoals, awayGoals) {
  let out = stripCjkText(String(text || ""));
  if (!out) return out;
  const hg = Number(homeGoals) || 0;
  const ag = Number(awayGoals) || 0;
  const scoreLabel = `${hg}-${ag}`;
  return out
    .replace(/\b\d{1,2}\s*[-–]\s*\d{1,2}\b/g, scoreLabel)
    .replace(/\bva\s+\d{1,2}\s*[-–]\s*\d{1,2}\b/gi, `va ${scoreLabel}`)
    .replace(/\bmarcador\s+\d{1,2}\s*[-–]\s*\d{1,2}\b/gi, `marcador ${scoreLabel}`);
}

async function updateLiveScore(id, patchIn = {}, opts = {}) {
  let current = null;
  try {
    const { data } = await db.from("abetlive").select("id,state,outcome").eq("id", id).limit(1);
    current = Array.isArray(data) ? data[0] : data;
  } catch {
    /* ignore */
  }

  const preserved = preserveSettledOutcome(
    current || {},
    patchIn.outcome != null ? patchIn.outcome : current?.outcome,
    patchIn.state != null ? patchIn.state : current?.state,
    { liveStyle: true }
  );

  const patch = {
    updated_at: new Date().toISOString(),
  };
  if (patchIn.minute != null) patch.minute = Number(patchIn.minute) || 0;
  if (patchIn.home_goals != null) patch.home_goals = Number(patchIn.home_goals) || 0;
  if (patchIn.away_goals != null) patch.away_goals = Number(patchIn.away_goals) || 0;

  // Si ya estaba liquidado: scores OK, resultado bloqueado (ended + outcome).
  if (preserved.locked) {
    patch.state = preserved.state;
    patch.outcome = preserved.outcome;
    patch.live_ended = true;
  } else {
    if (patchIn.state) patch.state = patchIn.state;
    if (patchIn.outcome != null) patch.outcome = patchIn.outcome;
  }

  const rationale = opts.ai_rationale ?? patchIn.ai_rationale;
  if (rationale && patch.home_goals != null && patch.away_goals != null) {
    patch.ai_rationale = syncAnalysisScoreText(rationale, patch.home_goals, patch.away_goals);
  }

  const { error } = await db.from("abetlive").eq("id", id).update(patch);
  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("home_goals") || msg.includes("column")) {
      const slim = { updated_at: patch.updated_at };
      if (patch.minute != null) slim.minute = patch.minute;
      if (patch.state) slim.state = patch.state;
      if (patch.outcome != null) slim.outcome = patch.outcome;
      await db.from("abetlive").eq("id", id).update(slim);
      return;
    }
    throw new Error(error.message || "Error actualizando marcador live");
  }
}

/**
 * Marca filas live como ended solo si llevan mucho tiempo fuera del scoreboard.
 * No cierra al primer desaparecer (ESPN puede parpadear o fallar el match de nombres).
 */
async function reconcileStaleLivePredictions(activePairKeys, sinceIso, options = {}) {
  const minAgeMs = Number(options.minAgeMs) || 3 * 60 * 60 * 1000;
  const keys = activePairKeys instanceof Set ? activePairKeys : new Set(activePairKeys);
  let query = db
    .from("abetlive")
    .select("id,home_team_name,away_team_name,state,outcome,match_date,created_at,live_ended")
    .gte("created_at", sinceIso);
  let { data, error } = await query;

  if (error?.message?.toLowerCase().includes("state") || error?.message?.toLowerCase().includes("match_date")) {
    const fallback = await db
      .from("abetlive")
      .select("id,home_team_name,away_team_name,created_at,state,live_ended")
      .gte("created_at", sinceIso);
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    throw new Error(error.message || "Error reconciliando live");
  }
  const now = Date.now();
  for (const row of data || []) {
    if (!row.id || row.live_ended === true || String(row.state || "").toLowerCase() === "ended") continue;
    // No tocar tips ya liquidados: solo marcar ended conservando won/lost.
    const locked = settledFromRow(row);
    const k = `${row.home_team_name}|${row.away_team_name}`;
    if (keys.has(k)) continue;
    const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
    const ageMs = createdMs ? now - createdMs : 0;
    if (ageMs < minAgeMs) continue;
    if (locked) {
      await finalizeLivePrediction(row.id, { outcome: locked, state: locked });
    } else {
      // Intentar liquidar con marcador de la fila antes de dejar pending.
      let outcome = "pending";
      try {
        const full = await db.from("abetlive").select("*").eq("id", row.id).limit(1);
        const r = Array.isArray(full.data) ? full.data[0] : full.data;
        if (r) {
          const hg = Number(r.home_goals) || 0;
          const ag = Number(r.away_goals) || 0;
          const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
          const sport = String(r.sport || "football").toLowerCase();
          if ((sport === "football" || sport === "soccer") && (hg + ag > 0 || Number(r.minute) >= 70)) {
            outcome =
              evaluateFootballPickFromText(
                r.prediction,
                hg,
                ag,
                r.home_team_name,
                r.away_team_name,
                { matchFinished: true }
              ) || "pending";
          }
        }
      } catch {
        /* ignore */
      }
      await finalizeLivePrediction(row.id, { outcome, state: "ended" });
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
    .select(
      "id,state,outcome,match_date,created_at,live_ended,home_goals,away_goals,minute,prediction,home_team_name,away_team_name,sport"
    )
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
      const locked = settledFromRow(row);
      // No reescribir pending si ya está cerrado sin resultado; lo repara settleUnresolved.
      if (locked) {
        await finalizeLivePrediction(row.id, {
          outcome: locked,
          state: "ended",
          home_goals: row.home_goals,
          away_goals: row.away_goals,
          minute: row.minute,
        });
        closed += 1;
      }
      continue;
    }
    const d = rowMatchDate(row);
    if (d && d < today) {
      const locked = settledFromRow(row);
      const hg = Number(row.home_goals) || 0;
      const ag = Number(row.away_goals) || 0;
      let outcome = locked || null;
      if (!outcome && (hg + ag > 0 || Number(row.minute) >= 70)) {
        try {
          const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
          const sport = String(row.sport || "football").toLowerCase();
          if (sport === "football" || sport === "soccer") {
            outcome =
              evaluateFootballPickFromText(
                row.prediction,
                hg,
                ag,
                row.home_team_name,
                row.away_team_name,
                { matchFinished: true }
              ) || null;
          }
        } catch {
          /* ignore */
        }
      }
      await finalizeLivePrediction(row.id, {
        outcome: outcome || locked || "pending",
        state: locked || outcome ? (outcome === "void" ? "void" : "ended") : "ended",
        home_goals: hg,
        away_goals: ag,
        minute: row.minute,
      });
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
  getUnresolvedEndedLiveRows,
  finalizeLivePrediction,
  updateLiveScore,
  finalizeStaleLiveByCalendar,
  todayLiveDate,
  rowMatchDate,
  isLiveState,
};
