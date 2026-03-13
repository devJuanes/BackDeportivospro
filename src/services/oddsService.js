const { clamp } = require("../utils/helpers");

function estimateOddsFromConfidence(confidence = 50) {
  const c = clamp(confidence, 1, 95);
  const impliedProbability = c / 100;
  const odds = 1 / impliedProbability;
  return Number(odds.toFixed(2));
}

module.exports = {
  estimateOddsFromConfidence,
};
