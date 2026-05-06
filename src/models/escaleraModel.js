const { db } = require("../config/database");

const TABLES = {
  sessions: "ladder_sessions",
  steps: "ladder_steps",
  events: "ladder_events",
  recos: "ladder_recommendations",
  tokens: "notification_tokens",
  tokensAlt: "project_push_tokens",
  logs: "notification_logs",
  logsAlt: "project_notification_deliveries",
};

function isMissingTableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return msg.includes("table does not exist") || msg.includes("relation") && msg.includes("does not exist");
}

async function getActiveSession(userId) {
  const { data, error } = await db
    .from(TABLES.sessions)
    .select("*")
    .eq("user_id", userId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function createSession(input) {
  const { data, error } = await db.from(TABLES.sessions).insert(input);
  if (error) throw new Error(error.message);
  if (data) return Array.isArray(data) ? data[0] : data;
  const { data: row, error: fetchError } = await db
    .from(TABLES.sessions)
    .select("*")
    .eq("user_id", input.user_id)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!row) throw new Error("No se pudo recuperar la sesión creada");
  return row;
}

async function updateSession(id, patch) {
  const { data, error } = await db
    .from(TABLES.sessions)
    .eq("id", id)
    .update(patch);
  if (error) throw new Error(error.message);
  if (data) return Array.isArray(data) ? data[0] : data;
  const { data: row, error: fetchError } = await db.from(TABLES.sessions).select("*").eq("id", id).maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!row) throw new Error("No se pudo recuperar la sesión actualizada");
  return row;
}

async function listSessionHistory(userId, limit = 20) {
  const { data, error } = await db
    .from(TABLES.sessions)
    .select("*")
    .eq("user_id", userId)
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

async function getActiveStep(sessionId) {
  const { data, error } = await db
    .from(TABLES.steps)
    .select("*")
    .eq("session_id", sessionId)
    .in("status", ["pending", "accepted"])
    .order("step_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function getLastStep(sessionId) {
  const { data, error } = await db
    .from(TABLES.steps)
    .select("*")
    .eq("session_id", sessionId)
    .order("step_index", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function createStep(input) {
  const { data, error } = await db.from(TABLES.steps).insert(input);
  if (error) throw new Error(error.message);
  if (data) return Array.isArray(data) ? data[0] : data;
  const { data: row, error: fetchError } = await db
    .from(TABLES.steps)
    .select("*")
    .eq("session_id", input.session_id)
    .eq("step_index", input.step_index)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!row) throw new Error("No se pudo recuperar el paso creado");
  return row;
}

async function updateStep(id, patch) {
  const { data, error } = await db
    .from(TABLES.steps)
    .eq("id", id)
    .update(patch);
  if (error) throw new Error(error.message);
  if (data) return Array.isArray(data) ? data[0] : data;
  const { data: row, error: fetchError } = await db.from(TABLES.steps).select("*").eq("id", id).maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!row) throw new Error("No se pudo recuperar el step actualizado");
  return row;
}

async function getStepById(id) {
  const { data, error } = await db.from(TABLES.steps).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function insertEvent(row) {
  const { error } = await db.from(TABLES.events).insert(row);
  if (error) {
    if (isMissingTableError(error)) return;
    throw new Error(error.message);
  }
}

async function insertRecommendation(row) {
  const { error } = await db.from(TABLES.recos).insert(row);
  if (error) {
    if (isMissingTableError(error)) return;
    throw new Error(error.message);
  }
}

async function recalcSessionCounters(sessionId) {
  const { data: steps, error: stepsErr } = await db
    .from(TABLES.steps)
    .select("status")
    .eq("session_id", sessionId);
  if (stepsErr) throw new Error(stepsErr.message);
  const won = (steps || []).filter((x) => x.status === "won").length;
  const lost = (steps || []).filter((x) => x.status === "lost").length;
  const total = won + lost;
  return updateSession(sessionId, {
    steps_won: won,
    steps_lost: lost,
    steps_total: total,
    updated_at: new Date().toISOString(),
  });
}

async function upsertUserToken(userId, token, deviceInfo = {}) {
  const primary = await db
    .from(TABLES.tokens)
    .upsert(
      { user_id: userId, token, app_id: "matupicks", device_info: deviceInfo, last_used_at: new Date().toISOString() },
      { onConflict: "user_id,app_id,token" }
    );
  if (!primary.error) {
    const { data: row } = await db
      .from(TABLES.tokens)
      .select("*")
      .eq("user_id", userId)
      .eq("token", token)
      .eq("app_id", "matupicks")
      .limit(1)
      .maybeSingle();
    return row || { user_id: userId, token, app_id: "matupicks" };
  }
  if (!isMissingTableError(primary.error)) throw new Error(primary.error.message);

  const fallback = await db
    .from(TABLES.tokensAlt)
    .upsert(
      { user_id: userId, fcm_token: token, platform: "android", device_info: deviceInfo, last_seen_at: new Date().toISOString() },
      { onConflict: "user_id,fcm_token" }
    );
  if (fallback.error) throw new Error(fallback.error.message);
  const { data: row, error: fetchError } = await db
    .from(TABLES.tokensAlt)
    .select("*")
    .eq("user_id", userId)
    .eq("fcm_token", token)
    .limit(1)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  return row || { user_id: userId, fcm_token: token };
}

async function deleteUserToken(userId, token) {
  const primary = await db
    .from(TABLES.tokens)
    .eq("user_id", userId)
    .eq("token", token)
    .eq("app_id", "matupicks")
    .delete();
  if (!primary.error) return;
  if (!isMissingTableError(primary.error)) throw new Error(primary.error.message);
  const { error } = await db
    .from(TABLES.tokensAlt)
    .eq("user_id", userId)
    .eq("fcm_token", token)
    .delete();
  if (error) throw new Error(error.message);
}

async function getUserTokens(userId) {
  const primary = await db
    .from(TABLES.tokens)
    .select("token")
    .eq("user_id", userId)
    .eq("app_id", "matupicks");
  if (!primary.error) return (primary.data || []).map((r) => r.token).filter(Boolean);
  if (!isMissingTableError(primary.error)) throw new Error(primary.error.message);
  const { data, error } = await db
    .from(TABLES.tokensAlt)
    .select("fcm_token")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.fcm_token).filter(Boolean);
}

async function createNotificationLog(row) {
  const { data, error } = await db.from(TABLES.logs).insert(row);
  if (error) {
    if (isMissingTableError(error)) {
      const sourceKind = String(row?.payload?.source_kind || "escalera");
      const sourceId = String(row?.payload?.source_id || row?.id || Date.now());
      const fallback = await db
        .from(TABLES.logsAlt)
        .insert({
          user_id: row.recipient_id,
          source_kind: sourceKind,
          source_id: sourceId,
          payload: row.payload || {},
        });
      if (fallback.error && !isMissingTableError(fallback.error)) {
        throw new Error(fallback.error.message);
      }
      return null;
    }
    throw new Error(error.message);
  }
  if (data) return Array.isArray(data) ? data[0] : data;
  const { data: inserted, error: fetchError } = await db
    .from(TABLES.logs)
    .select("*")
    .eq("recipient_id", row.recipient_id)
    .eq("title", row.title)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fetchError) {
    if (isMissingTableError(fetchError)) return null;
    throw new Error(fetchError.message);
  }
  if (!inserted) throw new Error("No se pudo recuperar el log de notificación creado");
  return inserted;
}

async function updateNotificationLog(id, patch) {
  const { error } = await db.from(TABLES.logs).eq("id", id).update(patch);
  if (error) throw new Error(error.message);
}

module.exports = {
  getActiveSession,
  createSession,
  updateSession,
  listSessionHistory,
  getActiveStep,
  getLastStep,
  createStep,
  updateStep,
  getStepById,
  insertEvent,
  insertRecommendation,
  recalcSessionCounters,
  upsertUserToken,
  deleteUserToken,
  getUserTokens,
  createNotificationLog,
  updateNotificationLog,
};
