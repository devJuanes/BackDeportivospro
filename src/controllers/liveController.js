const { getLivePredictions, createLivePrediction } = require("../models/liveModel");
const { getCurrentLiveSignals } = require("../services/liveSignalService");

async function listLivePredictions(req, res, next) {
  try {
    const currentOnly = req.query.current !== "false";
    if (currentOnly) {
      const signals = await getCurrentLiveSignals({ sport: req.query.sport });
      return res.json(signals);
    }

    const minutes = Number.parseInt(req.query.minutes || "45", 10);
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const rows = await getLivePredictions(100, {
      sport: req.query.sport,
      sinceIso,
    });
    return res.json(rows);
  } catch (error) {
    return next(error);
  }
}

async function createLive(req, res, next) {
  try {
    const row = await createLivePrediction(req.body);
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listLivePredictions,
  createLive,
};
