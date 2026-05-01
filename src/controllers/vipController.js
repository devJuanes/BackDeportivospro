const {
  getVipPredictions,
  createVipPrediction,
  updateVipPredictionState,
  updateVipModerationStatus,
  getVipSummaryToday,
} = require("../models/vipModel");
const { sendMessage } = require("../config/whatsapp");

function buildVipMessage(prediction) {
  return `🔥 PRONOSTICO VIP

${prediction.home_team_name || prediction.team_a || prediction.homeTeam?.name} vs ${
    prediction.away_team_name || prediction.team_b || prediction.awayTeam?.name
  }

Pronostico VIP:
${prediction.prediction || prediction.pick_text}

Confianza:
${prediction.confidence}%

Cuota:
${prediction.odds}

Resumen:
${prediction.rationale_short || "Señal VIP con mayor filtro de contexto."}`;
}

async function listVipPredictions(req, res, next) {
  try {
    const rows = await getVipPredictions(100, {
      todayOnly: req.query.today === "true",
      sport: req.query.sport,
      date: req.query.date,
      moderationStatus: req.query.moderation || "active",
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

async function createVip(req, res, next) {
  try {
    const prediction = await createVipPrediction(req.body);
    const to = process.env.WHATSAPP_PHONE_VIP;
    if (to) {
      await sendMessage(to, buildVipMessage(prediction));
    }
    res.status(201).json(prediction);
  } catch (error) {
    next(error);
  }
}

async function updateVipState(req, res, next) {
  try {
    const row = await updateVipPredictionState(req.params.id, req.body.state);
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function updateVipModeration(req, res, next) {
  try {
    const moderation = String(req.body.moderation_status || "").toLowerCase();
    if (!["pending", "active", "rejected"].includes(moderation)) {
      return res.status(400).json({ error: "moderation_status inválido" });
    }
    const row = await updateVipModerationStatus(
      req.params.id,
      moderation,
      req.body.moderation_note || null
    );
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function getVipDailySummary(req, res, next) {
  try {
    const summary = await getVipSummaryToday();
    res.json(summary);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listVipPredictions,
  createVip,
  updateVipState,
  updateVipModeration,
  getVipDailySummary,
};
