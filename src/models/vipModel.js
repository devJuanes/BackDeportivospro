const {
  getPredictions,
  createPrediction,
  updatePredictionState,
  getSummaryToday,
} = require("./dpPredictionModel");

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
    });
    all.push(...rows);
  }
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all.slice(0, limit);
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
