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

async function scrapeSportsNews() {
  const sources = [
    {
      name: "ESPN",
      url: "https://www.espn.com/",
      cardSelector: "section article",
      titleSelector: "h1, h2, h3",
      linkSelector: "a",
      imageSelector: "img",
    },
  ];

  const allNews = [];

  for (const source of sources) {
    try {
      const { data } = await axios.get(source.url, { timeout: 15000 });
      const $ = cheerio.load(data);

      $(source.cardSelector).each((_, el) => {
        const title = normalizeText($(el).find(source.titleSelector).first().text());
        const link = $(el).find(source.linkSelector).first().attr("href");
        const image = $(el).find(source.imageSelector).first().attr("src");

        if (title && link) {
          const absoluteUrl = toAbsoluteUrl(source.url, link);
          if (!absoluteUrl) {
            return;
          }
          allNews.push({
            title,
            summary: title,
            url: absoluteUrl,
            image: image || "",
            source: source.name,
          });
        }
      });
    } catch (error) {
      // Si falla una fuente, seguimos con las demás.
    }
  }

  return allNews.slice(0, 25);
}

module.exports = {
  scrapeSportsNews,
};
