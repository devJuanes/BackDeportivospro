const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeText } = require("../utils/helpers");

async function scrapePredictz() {
  const url = "https://www.predictz.com/predictions/";
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const $ = cheerio.load(response.data);
  const rows = [];

  $(".pttr").each((_, el) => {
    const match = normalizeText($(el).find(".ptm").text());
    const prediction = normalizeText($(el).find(".ptprd").text());
    const score = normalizeText($(el).find(".ptsc").text());
    const probability = normalizeText($(el).find(".ptper").text());

    if (match) {
      rows.push({
        source: "PredictZ",
        source_url: "https://www.predictz.com",
        match,
        prediction: prediction || "Sin dato",
        probability: probability || "N/A",
        score: score || "N/A",
      });
    }
  });

  return rows.slice(0, 20);
}

module.exports = {
  scrapePredictz,
};
