const { db } = require("../config/database");
const { callChatModel, isAiEnabled } = require("./aiForecastService");
const { sendPushToTokens } = require("./firebasePushService");
const model = require("../models/escaleraModel");

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function pickCandidate() {
  const vip = await db.from("vip_picks").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(1);
  if (!vip.error && vip.data?.length) return { source: "vip_picks", row: vip.data[0] };
  const free = await db.from("free_picks").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(1);
  if (!free.error && free.data?.length) return { source: "free_picks", row: free.data[0] };
  return null;
}

async function generateRecommendation(session, stepIndex, candidate) {
  const fallback = {
    match: candidate ? `${candidate.row.team_a} vs ${candidate.row.team_b}` : "Partido por definir",
    league: candidate?.row?.league || "",
    market: candidate?.row?.pick_text || "Más de 1.5 goles",
    recommended_stake: Math.max(1, Math.round(toNum(session.capital_current) * 0.12)),
    recommended_odds: Math.max(1.2, toNum(candidate?.row?.odds, 1.7)),
    confidence: Math.min(95, Math.max(55, toNum(candidate?.row?.confidence, 70))),
    rationale: "Stake conservador para sostener la escalera con riesgo controlado.",
    match_time: candidate?.row?.match_date || "",
    source: candidate?.source || "ai",
    model: "fallback",
  };
  if (!isAiEnabled()) return fallback;
  try {
    const prompt = [
      "Devuelve SOLO JSON.",
      "Genera recomendación de reto escalera:",
      JSON.stringify({
        bankroll: toNum(session.capital_current),
        target: toNum(session.daily_target),
        step_index: stepIndex,
        candidate: candidate ? {
          league: candidate.row.league,
          match: `${candidate.row.team_a} vs ${candidate.row.team_b}`,
          market: candidate.row.pick_text,
          odds: candidate.row.odds,
          confidence: candidate.row.confidence,
        } : null,
      }),
      'Formato: {"match":"","league":"","market":"","recommended_stake":0,"recommended_odds":0,"confidence":0,"rationale":"","match_time":"","source":"ai"}',
    ].join("\n");
    const ai = await callChatModel(prompt, "Responde JSON compacto.");
    return {
      ...fallback,
      ...ai,
      recommended_stake: Math.max(1, toNum(ai.recommended_stake, fallback.recommended_stake)),
      recommended_odds: Math.max(1.01, toNum(ai.recommended_odds, fallback.recommended_odds)),
      confidence: Math.min(100, Math.max(0, toNum(ai.confidence, fallback.confidence))),
      model: process.env.FACTORY_AI_MODEL || "deepseek-chat",
    };
  } catch {
    return fallback;
  }
}

async function sendEscaleraPush(userId, title, body, data, sourceId) {
  const log = await model.createNotificationLog({
    app_id: "matupicks",
    recipient_id: userId,
    title,
    body,
    payload: data || {},
    status: "pending",
  });
  try {
    const tokens = await model.getUserTokens(userId);
    if (!tokens.length) {
      await model.updateNotificationLog(log.id, { status: "failed", error_message: "No tokens" });
      return;
    }
    const result = await sendPushToTokens({
      tokens,
      title,
      body,
      data: { ...(data || {}), source_kind: "escalera", source_id: sourceId || "" },
      channelId: "escalera_updates",
    });
    await model.updateNotificationLog(log.id, {
      status: result.sentCount > 0 ? "sent" : "failed",
      error_message: result.sentCount > 0 ? null : "FCM failed",
    });
  } catch (e) {
    await model.updateNotificationLog(log.id, { status: "failed", error_message: e.message });
  }
}

async function openSession({ userId, capitalInitial, dailyTarget, multiplierMode = "auto", notes = null }) {
  const existing = await model.getActiveSession(userId);
  if (existing) throw fail("Ya tienes una sesión abierta", 409);
  const ci = toNum(capitalInitial);
  const dt = toNum(dailyTarget);
  if (ci <= 0 || dt <= 0) throw fail("capital_initial y daily_target deben ser > 0");
  const session = await model.createSession({
    user_id: userId,
    capital_initial: ci,
    capital_current: ci,
    daily_target: dt,
    multiplier_mode: multiplierMode,
    status: "open",
    notes,
  });
  await model.insertEvent({ session_id: session.id, event_type: "open_session", payload: { ci, dt } });
  return session;
}

async function closeSession({ userId, sessionId, reason = "closed" }) {
  const session = sessionId ? await db.from("ladder_sessions").select("*").eq("id", sessionId).maybeSingle() : { data: await model.getActiveSession(userId) };
  const row = session.data;
  if (!row || row.user_id !== userId) throw fail("Sesión no encontrada", 404);
  const next = reason === "target_reached" ? "target_reached" : reason === "busted" ? "busted" : "closed";
  const updated = await model.updateSession(row.id, { status: next, closed_at: new Date().toISOString() });
  await model.insertEvent({ session_id: row.id, event_type: "close_session", payload: { reason: next } });
  return updated;
}

async function getOverview(userId) {
  const session = await model.getActiveSession(userId);
  if (!session) return { session: null, activeStep: null };
  const activeStep = await model.getActiveStep(session.id);
  return { session, activeStep };
}

async function listHistory(userId, limit = 20) {
  return model.listSessionHistory(userId, limit);
}

async function generateNext(userId, sessionId) {
  const session = sessionId
    ? (await db.from("ladder_sessions").select("*").eq("id", sessionId).maybeSingle()).data
    : await model.getActiveSession(userId);
  if (!session || session.user_id !== userId) throw fail("No hay sesión activa", 404);
  const active = await model.getActiveStep(session.id);
  if (active) return { session, step: active };
  const last = await model.getLastStep(session.id);
  const nextIndex = (last?.step_index || 0) + 1;
  const candidate = await pickCandidate();
  const rec = await generateRecommendation(session, nextIndex, candidate);
  const step = await model.createStep({
    session_id: session.id,
    step_index: nextIndex,
    status: "pending",
    prediction_source: rec.source || "ai",
    prediction_ref_id: candidate?.row?.id || null,
    prediction_payload: {
      match: rec.match,
      league: rec.league,
      market: rec.market,
      match_time: rec.match_time,
    },
    recommended_stake: rec.recommended_stake,
    recommended_odds: rec.recommended_odds,
    rationale: rec.rationale,
    confidence: rec.confidence,
  });
  await model.insertRecommendation({
    step_id: step.id,
    session_id: session.id,
    model: rec.model,
    payload: rec,
  });
  await model.insertEvent({ session_id: session.id, step_id: step.id, event_type: "recommend", payload: rec });
  await sendEscaleraPush(
    userId,
    `Nuevo pick escalera · Paso ${nextIndex}`,
    `${rec.match} · ${rec.market}`,
    { open_tab: "escalera", open_entity_id: step.id },
    step.id
  );
  return { session, step };
}

async function acceptStep(userId, stepId, stakeActual, executedOdds) {
  const step = await model.getStepById(stepId);
  if (!step) throw fail("Step no encontrado", 404);
  const ses = (await db.from("ladder_sessions").select("*").eq("id", step.session_id).maybeSingle()).data;
  if (!ses || ses.user_id !== userId) throw fail("No autorizado", 403);
  if (step.status !== "pending") throw fail("El step no está pendiente", 409);
  const stake = toNum(stakeActual, toNum(step.recommended_stake));
  const odds = Math.max(1.01, toNum(executedOdds, toNum(step.recommended_odds)));
  const updated = await model.updateStep(step.id, {
    status: "accepted",
    stake_actual: stake,
    executed_odds: odds,
    decided_at: new Date().toISOString(),
  });
  await model.insertEvent({ session_id: ses.id, step_id: step.id, event_type: "accept", payload: { stake, odds } });
  return updated;
}

async function rejectStep(userId, stepId) {
  const step = await model.getStepById(stepId);
  if (!step) throw fail("Step no encontrado", 404);
  const ses = (await db.from("ladder_sessions").select("*").eq("id", step.session_id).maybeSingle()).data;
  if (!ses || ses.user_id !== userId) throw fail("No autorizado", 403);
  if (step.status !== "pending") throw fail("Solo se puede rechazar en estado pending", 409);
  await model.updateStep(step.id, { status: "rejected", decided_at: new Date().toISOString() });
  await model.insertEvent({ session_id: ses.id, step_id: step.id, event_type: "reject", payload: { by: "user" } });
  return generateNext(userId, ses.id);
}

async function resolveStep(userId, stepId, outcome, executedOdds) {
  const step = await model.getStepById(stepId);
  if (!step) throw fail("Step no encontrado", 404);
  const ses = (await db.from("ladder_sessions").select("*").eq("id", step.session_id).maybeSingle()).data;
  if (!ses || ses.user_id !== userId) throw fail("No autorizado", 403);
  if (step.status !== "accepted") throw fail("Solo se resuelve un step accepted", 409);
  if (!["won", "lost"].includes(outcome)) throw fail("Outcome inválido");
  const stake = toNum(step.stake_actual, toNum(step.recommended_stake));
  const odds = Math.max(1.01, toNum(executedOdds, toNum(step.executed_odds, toNum(step.recommended_odds))));
  const pnl = outcome === "won" ? +(stake * (odds - 1)).toFixed(2) : -Math.abs(stake);
  const balance = +(toNum(ses.capital_current) + pnl).toFixed(2);
  await model.updateStep(step.id, {
    status: outcome,
    executed_odds: odds,
    profit_loss: pnl,
    balance_after: balance,
    resolved_at: new Date().toISOString(),
  });
  let status = "open";
  if (balance <= 0) status = "busted";
  if (balance - toNum(ses.capital_initial) >= toNum(ses.daily_target)) status = "target_reached";
  const updatedSession = await model.updateSession(ses.id, {
    capital_current: balance,
    status,
    closed_at: status === "open" ? null : new Date().toISOString(),
  });
  await model.recalcSessionCounters(ses.id);
  await model.insertEvent({
    session_id: ses.id,
    step_id: step.id,
    event_type: outcome === "won" ? "win" : "lose",
    payload: { pnl, balance, odds, stake },
  });
  if (status === "open" && outcome === "won") {
    await generateNext(userId, ses.id);
  } else if (status !== "open") {
    await sendEscaleraPush(
      userId,
      status === "target_reached" ? "Meta cumplida" : "Sesión cerrada",
      status === "target_reached" ? "Se alcanzó la meta diaria." : "Bankroll agotado.",
      { open_tab: "escalera", open_entity_id: ses.id },
      `${ses.id}:${status}`
    );
  }
  return getOverview(userId);
}

async function registerPushToken(userId, token, deviceInfo = {}) {
  return model.upsertUserToken(userId, token, deviceInfo);
}

async function unregisterPushToken(userId, token) {
  await model.deleteUserToken(userId, token);
  return { ok: true };
}

module.exports = {
  openSession,
  closeSession,
  getOverview,
  listHistory,
  generateNext,
  acceptStep,
  rejectStep,
  resolveStep,
  registerPushToken,
  unregisterPushToken,
};
