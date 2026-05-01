const { getFactorySports, getLiveMatchesBySport } = require("./sportsService");
const { generateLiveSuggestion } = require("./predictionEngine");
const { liveSignalDedupeKey } = require("../utils/predictionDedupe");

async function getCurrentLiveSignals(options = {}) {
  const requestedSport = options.sport;
  const sports = requestedSport
    ? [requestedSport]
    : getFactorySports().filter((sport) => sport !== "esports");

  const signals = [];
  const seen = new Set();

  for (const sport of sports) {
    let liveMatches = [];
    try {
      liveMatches = await getLiveMatchesBySport(sport);
    } catch {
      liveMatches = [];
    }

    for (const match of liveMatches) {
      const suggestion = generateLiveSuggestion(match);
      if (!suggestion) {
        continue;
      }
      const dk = liveSignalDedupeKey(
        suggestion.sport,
        suggestion.home_team_name,
        suggestion.away_team_name,
        suggestion.prediction
      );
      if (seen.has(dk)) {
        continue;
      }
      seen.add(dk);
      signals.push({
        ...suggestion,
        created_at: new Date().toISOString(),
        source: "live-feed",
      });
    }
  }

  return signals;
}

module.exports = {
  getCurrentLiveSignals,
};
