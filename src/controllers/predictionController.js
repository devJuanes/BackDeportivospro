const {
  getFreePredictions,
  createFreePrediction,
  updateFreePredictionState,
  getFreeSummaryToday,
} = require("../models/predictionModel");
const { sendMessage } = require("../config/whatsapp");

function buildWhatsappMessage(prediction) {
  return `⚽ PRONOSTICO DEL DIA

${prediction.home_team_name || prediction.homeTeam?.name} vs ${
    prediction.away_team_name || prediction.awayTeam?.name
  }

Pronostico:
${prediction.prediction}

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
  getFreeDailySummary,
};
