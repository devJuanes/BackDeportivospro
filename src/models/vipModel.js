const {
  getPredictions,
  createPrediction,
  updatePredictionState,
  getSummaryToday,
} = require("./dpPredictionModel");
const { sortByKickoffAsc } = require("../utils/matchSchedule");
const { collapsePicksForDisplay } = require("../utils/pickVolume");

async function getVipPredictions(limit = 100, filters = {}) {
  const tiers = filters.singleTier
    ? [filters.tier || "vip"]
    : ["vip", "premium", "super", "top"];
  const all = [];
  for (const tier of tiers) {
    const rows = await getPredictions(Math.ceil(limit / tiers.length) + 10, {
      tier,
      todayOnly: filters.todayOnly,
      date: filters.date,
      sport: filters.sport,
      published: true,
      collapse: filters.collapse,
    });
    all.push(...rows);
  }
  const unique = filters.collapse === false ? all : collapsePicksForDisplay(all);
  return sortByKickoffAsc(unique).slice(0, limit);
}

async function createVipPrediction(payload) {
  return createPrediction(payload, "vip");
}

async function updateVipPredictionState(id, state) {
  return updatePredictionState(id, state);
}

async function updateVipModerationStatus(id, _status, _note) {
  return updatePredictionState(id, "pending");
}

async function getVipSummaryToday() {
  return getSummaryToday("vip");
}

module.exports = {
  getVipPredictions,
  createVipPrediction,
  updateVipPredictionState,
  updateVipModerationStatus,
  getVipSummaryToday,
};
