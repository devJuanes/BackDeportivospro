const {
  getFreePredictions,
  createFreePrediction,
  updateFreePredictionState,
  updateFreeModerationStatus,
  getFreeSummaryToday,
} = require("../models/predictionModel");
const { sendMessage } = require("../config/whatsapp");

function buildWhatsappMessage(prediction) {
  return `⚽ PRONOSTICO DEL DIA

${prediction.home_team_name || prediction.team_a || prediction.homeTeam?.name} vs ${
    prediction.away_team_name || prediction.team_b || prediction.awayTeam?.name
  }

Pronostico:
${prediction.prediction || prediction.pick_text}

Confianza:
${prediction.confidence}%

Cuota:
${prediction.odds}

Resumen:
${prediction.rationale_short || "Consenso estadístico del día."}`;
}

async function listFreePredictions(req, res, next) {
  try {
    const rows = await getFreePredictions(100, {
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

async function createPrediction(req, res, next) {
  try {
    const prediction = await createFreePrediction(req.body);
    const to = process.env.WHATSAPP_PHONE_FREE;
    if (to) {
      await sendMessage(to, buildWhatsappMessage(prediction));
    }
    res.status(201).json(prediction);
  } catch (error) {
    next(error);
  }
}

async function updateFreeState(req, res, next) {
  try {
    const row = await updateFreePredictionState(req.params.id, req.body.state);
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function updateFreeModeration(req, res, next) {
  try {
    const moderation = String(req.body.moderation_status || "").toLowerCase();
    if (!["pending", "active", "rejected"].includes(moderation)) {
      return res.status(400).json({ error: "moderation_status inválido" });
    }
    const row = await updateFreeModerationStatus(
      req.params.id,
      moderation,
      req.body.moderation_note || null
    );
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function getFreeDailySummary(req, res, next) {
  try {
    const summary = await getFreeSummaryToday();
    res.json(summary);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listFreePredictions,
  createPrediction,
  updateFreeState,
  updateFreeModeration,
  getFreeDailySummary,
};
