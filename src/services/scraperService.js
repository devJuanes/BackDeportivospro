const logger = require("../utils/logger");
const { scrapeForebet } = require("../scrapers/forebetScraper");
const { scrapePredictz } = require("../scrapers/predictzScraper");
const { scrapeWinDrawWin } = require("../scrapers/windrawwinScraper");

async function safeRun(name, runner) {
  try {
    const items = await runner();
    logger.info(`${name} obtuvo ${items.length} predicciones.`);
    return items;
  } catch (error) {
    logger.warn(`${name} falló: ${error.message}`);
    return [];
  }
}

async function runAllPredictionScrapers() {
  const [forebet, predictz, windrawwin] = await Promise.all([
    safeRun("Forebet", scrapeForebet),
    safeRun("PredictZ", scrapePredictz),
    safeRun("Windrawwin", scrapeWinDrawWin),
  ]);

  return [...forebet, ...predictz, ...windrawwin];
}

module.exports = {
  runAllPredictionScrapers,
};
