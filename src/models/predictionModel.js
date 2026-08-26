const {
  getPredictions,
  createPrediction,
  updatePredictionState,
  getSummaryToday,
} = require("./dpPredictionModel");
const { formatDateInTimezone } = require("../utils/helpers");

function todayIsoDate() {
  return formatDateInTimezone(
    new Date(),
    process.env.FACTORY_TIMEZONE || "America/Bogota"
  );
}

async function getFreePredictions(limit = 100, filters = {}) {
  return getPredictions(limit, {
    tier: "free",
    todayOnly: filters.todayOnly,
    date: filters.date,
    sport: filters.sport,
    published: true,
  });
}

async function createFreePrediction(payload) {
  return createPrediction(payload, "free");
}

async function updateFreePredictionState(id, state) {
  return updatePredictionState(id, state);
}

async function updateFreeModerationStatus(id, _status, _note) {
  return updatePredictionState(id, "pending");
}

async function getFreeSummaryToday() {
  return getSummaryToday("free");
}

module.exports = {
  getFreePredictions,
  createFreePrediction,
  updateFreePredictionState,
  updateFreeModerationStatus,
  getFreeSummaryToday,
};
