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

function toMatchDateTime(row, now, fallbackDate) {
  const date = String(row.match_date || fallbackDate || now.toISOString().slice(0, 10));
  const hhmm = String(row.match_hour || row.match_time || "").trim();
  if (!hhmm) return null;
  const [hRaw, mRaw] = hhmm.split(":");
  const h = Number.parseInt(hRaw || "0", 10);
  const m = Number.parseInt(mRaw || "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const dt = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isFreshStandardCandidate(row, now, fallbackDate) {
  const today = now.toISOString().slice(0, 10);
  const dateOnly = String(row.match_date || fallbackDate || today);
  // Escalera es diaria: solo picks del día actual.
  if (dateOnly !== today) return false;
  const dt = toMatchDateTime(row, now, fallbackDate);
  if (!dt) {
    // Si no hay hora exacta, descartamos para evitar picks ambiguos/antiguos.
    return false;
  }
  const diffMin = Math.round((dt.getTime() - now.getTime()) / 60000);
  // Rechazar partidos ya pasados y también muy lejanos (meta diaria).
  return diffMin >= -15 && diffMin <= 240;
}

function isFreshLiveCandidate(row, now) {
  if (row.live_ended === true) return false;
  const state = String(row.state || "").toLowerCase();
  if (state && state !== "live" && state !== "inplay" && state !== "in_play") return false;
  const minute = Number(row.minute);
  if (Number.isFinite(minute) && minute > 90) return false;
  const createdAt = row.created_at ? new Date(String(row.created_at)) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return true;
  // Señales live demasiado viejas no sirven para Escalera.
  return now.getTime() - createdAt.getTime() <= 90 * 60 * 1000;
}

function formatCandidateMatchTime(row, now, today) {
  if (String(row.source || "").toLowerCase() === "abetlive") {
    const m = Number(row.minute);
    if (Number.isFinite(m) && m >= 0) return `EN VIVO · min ${m}`;
    return "EN VIVO";
  }
  const dt = toMatchDateTime(row, now, today);
  if (!dt) return today;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mi = String(dt.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function normalizeSigPart(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildCandidateSignature(row) {
  return [
    normalizeSigPart(row.team_a || row.home_team_name || row.home_team),
    normalizeSigPart(row.team_b || row.away_team_name || row.away_team),
    normalizeSigPart(row.pick_text || row.prediction || row.market),
  ].join("|");
}

async function pickCandidate({ excludeKeys = new Set(), excludeSignatures = new Set() } = {}) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const toMinutes = (row) => {
    const dt = toMatchDateTime(row, now, today);
    if (!dt) return Number.MAX_SAFE_INTEGER;
    return Math.round((dt.getTime() - now.getTime()) / 60000);
  };

  const normalize = (source, row) => ({
    source,
    row: {
      id: row.id,
      league: row.league || row.sport || "",
      team_a: row.team_a || row.home_team_name || row.home_team || "Local",
      team_b: row.team_b || row.away_team_name || row.away_team || "Visitante",
      pick_text: row.pick_text || row.prediction || row.market || "",
      confidence: toNum(row.confidence, 67),
      odds: toNum(row.odds, 1.65),
      analysis: row.analysis || row.ai_rationale || "",
      match_date: row.match_date || today,
      match_hour: row.match_hour || row.match_time || "",
      minutes_to_start: toMinutes(row),
      is_live: source === "abetlive",
    },
  });

  const bucket = [];

  const vip = await db
    .from("vip_picks")
    .select("id,league,team_a,team_b,pick_text,odds,confidence,analysis,match_date,match_hour")
    .eq("moderation_status", "active")
    .gte("match_date", today)
    .order("match_date", { ascending: true })
    .limit(40);
  if (!vip.error) {
    bucket.push(...(vip.data || []).filter((r) => isFreshStandardCandidate(r, now, today)).map((r) => normalize("vip_picks", r)));
  }

  const free = await db
    .from("free_picks")
    .select("id,league,team_a,team_b,pick_text,odds,confidence,analysis,match_date,match_hour")
    .eq("moderation_status", "active")
    .gte("match_date", today)
    .order("match_date", { ascending: true })
    .limit(40);
  if (!free.error) {
    bucket.push(...(free.data || []).filter((r) => isFreshStandardCandidate(r, now, today)).map((r) => normalize("free_picks", r)));
  }

  const live = await db
    .from("abetlive")
    .select("id,league,home_team_name,away_team_name,prediction,odds,confidence,minute,created_at,live_ended,state")
    .order("created_at", { ascending: false })
    .limit(12);
  if (!live.error) {
    bucket.push(
      ...(live.data || []).filter((r) => isFreshLiveCandidate(r, now)).map((r) =>
        normalize("abetlive", {
          ...r,
          source: "abetlive",
          match_date: today,
          match_hour: "",
          analysis: `Señal live minuto ${toNum(r.minute, 0)}.`,
        })
      )
    );
  }

  const fixtures = await db
    .from("fixtures_cache")
    .select("id,league,home_team,away_team,match_date,match_time")
    .gte("match_date", today)
    .order("match_date", { ascending: true })
    .order("match_time", { ascending: true })
    .limit(25);
  if (!fixtures.error) {
    bucket.push(
      ...(fixtures.data || []).filter((r) => isFreshStandardCandidate(r, now, today)).map((r) =>
        normalize("fixtures_cache", {
          ...r,
          pick_text: `Doble oportunidad ${r.home_team || "Local"} o empate`,
          odds: 1.65,
          confidence: 67,
          analysis: "Pick base de seguridad para escalera.",
        })
      )
    );
  }

  if (!bucket.length) return null;

  const ranked = bucket
    .filter((c) => c.row.pick_text && c.row.team_a && c.row.team_b)
    .filter((c) => !excludeKeys.has(`${c.source}:${String(c.row.id || "")}`))
    .filter((c) => !excludeSignatures.has(buildCandidateSignature(c.row)))
    .sort((a, b) => {
      const sourceScore = (s) =>
        s === "abetlive" ? 0 : s === "vip_picks" ? 1 : s === "free_picks" ? 2 : s === "fixtures_cache" ? 3 : 9;
      const sDiff = sourceScore(a.source) - sourceScore(b.source);
      if (sDiff !== 0) return sDiff;
      // Priorizar eventos más inmediatos.
      const tDiff = Math.abs(a.row.minutes_to_start) - Math.abs(b.row.minutes_to_start);
      if (tDiff !== 0) return tDiff;
      return b.row.confidence - a.row.confidence;
    });

  return ranked[0] || null;
}

async function generateRecommendation(session, stepIndex, candidate) {
  const teamA = candidate?.row?.team_a || candidate?.row?.home_team_name || candidate?.row?.homeTeam || "Local";
  const teamB = candidate?.row?.team_b || candidate?.row?.away_team_name || candidate?.row?.awayTeam || "Visitante";
  const market =
    candidate?.row?.pick_text ||
    candidate?.row?.prediction ||
    candidate?.row?.market ||
    "Más de 1.5 goles";
  const target = Math.max(0, toNum(session.daily_target) - Math.max(0, toNum(session.capital_current) - toNum(session.capital_initial)));
  const dynamicFraction = Math.min(0.22, Math.max(0.08, 0.09 + stepIndex * 0.015));
  const stakeByBank = Math.round(toNum(session.capital_current) * dynamicFraction);
  const fallbackStake = Math.max(1, Math.min(stakeByBank, target > 0 ? target : stakeByBank));
  const fallback = {
    match: `${teamA} vs ${teamB}`,
    league: candidate?.row?.league || "",
    market,
    recommended_stake: fallbackStake,
    recommended_odds: Math.max(1.2, toNum(candidate?.row?.odds, 1.7)),
    confidence: Math.min(95, Math.max(55, toNum(candidate?.row?.confidence, 70))),
    rationale:
      candidate?.row?.analysis ||
      "Stake conservador para sostener la escalera con riesgo controlado.",
    match_time: candidate ? formatCandidateMatchTime({ ...candidate.row, source: candidate.source }, new Date(), new Date().toISOString().slice(0, 10)) : "",
    source: candidate?.source || "ai",
    model: "fallback",
  };
  if (!isAiEnabled()) return fallback;
  try {
    const prompt = [
      "Devuelve SOLO JSON.",
      "Genera recomendación de reto escalera, de ALTA CALIDAD y accionable.",
      "Debe incluir partido y mercado específico (no genérico), idealmente de horario cercano.",
      JSON.stringify({
        bankroll: toNum(session.capital_current),
        target: toNum(session.daily_target),
        target_remaining: target,
        step_index: stepIndex,
        candidate: candidate ? {
          league: candidate.row.league,
          match: `${teamA} vs ${teamB}`,
          market,
          odds: candidate.row.odds,
          confidence: candidate.row.confidence,
        } : null,
      }),
      'Formato: {"match":"","league":"","market":"","recommended_stake":0,"recommended_odds":0,"confidence":0,"rationale":"","match_time":"","source":"ai"}',
      "No devuelvas 'por definir', 'mercado seguro' ni placeholders.",
    ].join("\n");
    const ai = await callChatModel(prompt, "Responde JSON compacto.");
    // Anti-hallucination: el partido/mercado debe respetar el candidato seleccionado.
    // La IA solo ajusta rationale/confianza/stake/cuota.
    return {
      ...fallback,
      rationale: ai?.rationale || fallback.rationale,
      confidence: ai?.confidence,
      recommended_stake: ai?.recommended_stake,
      recommended_odds: ai?.recommended_odds,
      source: ai?.source || fallback.source,
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
      if (log?.id) await model.updateNotificationLog(log.id, { status: "failed", error_message: "No tokens" });
      return;
    }
    const result = await sendPushToTokens({
      tokens,
      title,
      body,
      data: { ...(data || {}), source_kind: "escalera", source_id: sourceId || "" },
      channelId: "escalera_updates",
    });
    if (log?.id) {
      await model.updateNotificationLog(log.id, {
        status: result.sentCount > 0 ? "sent" : "failed",
        error_message: result.sentCount > 0 ? null : "FCM failed",
      });
    }
  } catch (e) {
    if (log?.id) await model.updateNotificationLog(log.id, { status: "failed", error_message: e.message });
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
  const sessionSteps = await db
    .from("ladder_steps")
    .select("prediction_source,prediction_ref_id,prediction_payload")
    .eq("session_id", session.id)
    .limit(200);
  const usedKeys = new Set(
    (sessionSteps?.data || [])
      .filter((r) => r.prediction_source && r.prediction_ref_id)
      .map((r) => `${r.prediction_source}:${String(r.prediction_ref_id)}`)
  );
  const usedSignatures = new Set(
    (sessionSteps?.data || [])
      .map((r) => {
        const payload = r?.prediction_payload || {};
        const match = String(payload.match || "");
        const parts = match.split(/\s+vs\s+/i);
        return [
          normalizeSigPart(parts[0] || match),
          normalizeSigPart(parts[1] || ""),
          normalizeSigPart(payload.market || ""),
        ].join("|");
      })
      .filter((sig) => sig !== "||")
  );
  const candidate = await pickCandidate({ excludeKeys: usedKeys, excludeSignatures: usedSignatures });
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
  if (stake <= 0) throw fail("El stake debe ser mayor a 0");
  if (stake > toNum(ses.capital_current)) throw fail("No puedes apostar más de tu capital actual", 409);
  if (stake > toNum(ses.capital_initial)) throw fail("El stake no puede superar el capital inicial", 409);
  const odds = Math.max(1.01, toNum(executedOdds, toNum(step.recommended_odds)));
  const updated = await model.updateStep(step.id, {
    status: "accepted",
    stake_actual: stake,
    executed_odds: odds,
    decided_at: new Date().toISOString(),
  });
  const afterAcceptBalance = +(toNum(ses.capital_current) - stake).toFixed(2);
  await model.updateSession(ses.id, { capital_current: afterAcceptBalance });
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
  const odds = Math.max(1.01, toNum(step.executed_odds, toNum(step.recommended_odds)));
  const pnl = outcome === "won" ? +(stake * (odds - 1)).toFixed(2) : -Math.abs(stake);
  const balance = outcome === "won"
    ? +(toNum(ses.capital_current) + stake * odds).toFixed(2)
    : +toNum(ses.capital_current).toFixed(2);
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
