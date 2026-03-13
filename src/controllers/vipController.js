const {
  getVipPredictions,
  createVipPrediction,
  updateVipPredictionState,
  getVipSummaryToday,
} = require("../models/vipModel");
const { sendMessage } = require("../config/whatsapp");

function buildVipMessage(prediction) {
  return `🔥 PRONOSTICO VIP

${prediction.home_team_name || prediction.homeTeam?.name} vs ${
    prediction.away_team_name || prediction.awayTeam?.name
  }

Pronostico VIP:
${prediction.prediction}

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
  getVipDailySummary,
};
