const { scrapeSportsNews } = require("../scrapers/newsScraper");
const { createNewsIfNew } = require("../models/newsModel");
const logger = require("../utils/logger");

async function collectAndStoreSportsNews() {
  const scraped = await scrapeSportsNews();
  const stored = [];

  for (const item of scraped) {
    try {
      const row = await createNewsIfNew(item);
      if (row) {
        stored.push(row);
      }
    } catch (error) {
      logger.warn(`No se pudo guardar noticia (${item.title}): ${error.message}`);
    }
  }

  logger.info(`Noticias guardadas: ${stored.length}`);
  return stored;
}

module.exports = {
  collectAndStoreSportsNews,
};
