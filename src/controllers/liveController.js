const {
  getLivePredictions,
  createLivePrediction,
} = require("../models/liveModel");
const { getCurrentLiveSignals } = require("../services/liveSignalService");
const { ensureLiveTrackingJob } = require("../models/dpPredictionModel");

async function listLivePredictions(req, res, next) {
  try {
    const currentOnly = req.query.current !== "false";
    if (currentOnly) {
      const signals = await getCurrentLiveSignals({ sport: req.query.sport });
      return res.json(signals);
    }

    // Histórico acotado: solo live del día (America/Bogota) o ventana corta.
    const minutes = Number.parseInt(req.query.minutes || "45", 10);
    const useDayFilter = req.query.today !== "false";
    const filters = {
      sport: req.query.sport,
      todayOnly: useDayFilter,
      liveOnly: req.query.includeEnded !== "true",
    };
    if (!useDayFilter) {
      filters.sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
      filters.todayOnly = false;
    }
    const rows = await getLivePredictions(100, filters);
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function createLive(req, res, next) {
  try {
    const row = await createLivePrediction(req.body);
    if (row?.id) {
      try {
        await ensureLiveTrackingJob(row.id, row.prediction_id || null);
      } catch {
        /* tracking opcional si la migración aún no aplicó */
      }
    }
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listLivePredictions,
  createLive,
};
