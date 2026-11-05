const { scrapeSportsNews } = require("../scrapers/newsScraper");
const { createNewsIfNew } = require("../models/newsModel");
const { appendOwnedNews } = require("../models/sportsNewsModel");
const { generateAndAppendAiFeed } = require("./newsAiFeedService");
const logger = require("../utils/logger");

/**
 * Ingesta noticias PROPIAS:
 * - scrapea título/resumen/imagen de fuentes
 * - descarga imagen a data/news/images
 * - guarda contenido en MatuDB (sin redirigir al medio)
 */
async function collectAndStoreSportsNews() {
  const scraped = await scrapeSportsNews();
  const stored = [];
  const feed = [];

  for (const item of scraped) {
    try {
      const row = await createNewsIfNew({
        ...item,
        // editorial: no forzar click-out
        url: item.url || "#",
      });
      if (row) stored.push(row);
    } catch (error) {
      logger.warn(`No se pudo guardar noticia editorial (${item.title}): ${error.message}`);
    }
    try {
      const sn = await appendOwnedNews(item);
      if (sn) feed.push(sn);
    } catch (error) {
      logger.warn(`No se pudo guardar noticia propia (${item.title}): ${error.message}`);
    }
  }

  let aiFeed = [];
  try {
    aiFeed = await generateAndAppendAiFeed();
  } catch (error) {
    logger.warn(`[news-ai] ${error.message}`);
  }

  const allNew = [...stored, ...feed, ...aiFeed];
  // Push noticias (máx. 2 por ciclo para no spamear)
  try {
    const { notifyNewsItem } = require("./predictionNotifyService");
    for (const item of allNew.slice(0, 2)) {
      await notifyNewsItem(item);
    }
  } catch (error) {
    logger.warn(`[news-push] ${error.message}`);
  }

  logger.info(
    `Noticias propias: editorial=${stored.length}, feed=${feed.length}, ia=${aiFeed.length}`
  );
  return allNew;
}

module.exports = {
  collectAndStoreSportsNews,
};
