const { scrapeSportsNews } = require("../scrapers/newsScraper");
const { createNewsIfNew } = require("../models/newsModel");
const { appendScrapedToSportsNews } = require("../models/sportsNewsModel");
const { generateAndAppendAiFeed } = require("./newsAiFeedService");
const logger = require("../utils/logger");

async function collectAndStoreSportsNews() {
  const scraped = await scrapeSportsNews();
  const stored = [];
  const feed = [];

  for (const item of scraped) {
    try {
      const row = await createNewsIfNew(item);
      if (row) {
        stored.push(row);
      }
    } catch (error) {
      logger.warn(`No se pudo guardar noticia (${item.title}): ${error.message}`);
    }
    try {
      const sn = await appendScrapedToSportsNews(item);
      if (sn) feed.push(sn);
    } catch (error) {
      logger.warn(`No se pudo volcar noticia al feed (${item.title}): ${error.message}`);
    }
  }

  let aiFeed = [];
  try {
    aiFeed = await generateAndAppendAiFeed();
  } catch (error) {
    logger.warn(`[news-ai] ${error.message}`);
  }

  logger.info(`Noticias guardadas (editorial): ${stored.length}, feed app: ${feed.length}, IA feed: ${aiFeed.length}`);
  return [...stored, ...feed, ...aiFeed];
}

module.exports = {
  collectAndStoreSportsNews,
};
