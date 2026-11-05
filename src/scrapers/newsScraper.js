const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeText } = require("../utils/helpers");

function toAbsoluteUrl(base, link) {
  try {
    return new URL(link, base).toString();
  } catch {
    return "";
  }
}

/**
 * Scrape noticias (título, resumen, imagen).
 * El contenido se guarda en MatuDB; NO redirigimos al medio original en la app.
 */
async function scrapeSportsNews() {
  const sources = [
    {
      name: "ESPN Deportes",
      url: "https://www.espn.com.mx/futbol/",
      cardSelector: "section article, .contentItem, .Headline",
      titleSelector: "h1, h2, h3, .contentItem__title",
      linkSelector: "a",
      imageSelector: "img",
    },
    {
      name: "ESPN",
      url: "https://www.espn.com/soccer/",
      cardSelector: "section article",
      titleSelector: "h1, h2, h3",
      linkSelector: "a",
      imageSelector: "img",
    },
    {
      name: "Marca",
      url: "https://www.marca.com/futbol.html",
      cardSelector: "article, .ue-c-cover-content",
      titleSelector: "h2, h3, a",
      linkSelector: "a",
      imageSelector: "img",
    },
  ];

  const allNews = [];
  const seen = new Set();

  for (const source of sources) {
    try {
      const { data } = await axios.get(source.url, {
        timeout: 18000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; MatuPicksBot/1.0; +https://matupicks.app)",
          Accept: "text/html",
        },
      });
      const $ = cheerio.load(data);

      $(source.cardSelector).each((_, el) => {
        if (allNews.length >= 40) return;
        const title = normalizeText($(el).find(source.titleSelector).first().text());
        const link = $(el).find(source.linkSelector).first().attr("href");
        let image =
          $(el).find(source.imageSelector).first().attr("src") ||
          $(el).find(source.imageSelector).first().attr("data-src") ||
          "";
        if (!title || !link) return;
        const absoluteUrl = toAbsoluteUrl(source.url, link);
        if (!absoluteUrl || seen.has(absoluteUrl)) return;
        seen.add(absoluteUrl);
        if (image && !image.startsWith("http")) {
          image = toAbsoluteUrl(source.url, image);
        }
        allNews.push({
          title,
          summary: title,
          content: title,
          url: absoluteUrl,
          image: image || "",
          source: source.name,
        });
      });
    } catch {
      /* fuente caída: seguir */
    }
  }

  return allNews.slice(0, 30);
}

module.exports = {
  scrapeSportsNews,
};
