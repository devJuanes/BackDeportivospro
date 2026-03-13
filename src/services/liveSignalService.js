const { getSupportedSports, getLiveMatchesBySport } = require("./sportsService");
const { generateLiveSuggestion } = require("./predictionEngine");

async function getCurrentLiveSignals(options = {}) {
  const requestedSport = options.sport;
  const sports = requestedSport
    ? [requestedSport]
    : getSupportedSports().filter((sport) => sport !== "esports");

  const signals = [];
  for (const sport of sports) {
    let liveMatches = [];
    try {
      liveMatches = await getLiveMatchesBySport(sport);
    } catch {
      liveMatches = [];
    }

    for (const match of liveMatches) {
      const suggestion = generateLiveSuggestion(match);
      if (suggestion) {
        signals.push({
          ...suggestion,
          created_at: new Date().toISOString(),
          source: "live-feed",
        });
      }
    }
  }

  return signals;
}

module.exports = {
  getCurrentLiveSignals,
};
