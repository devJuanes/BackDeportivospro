const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeText } = require("../utils/helpers");

async function scrapeForebet() {
  const url = "https://www.forebet.com/en/football-tips-and-predictions-for-today";
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

  $(".schema .tr_1, .schema .tr_0").each((_, el) => {
    const teams = normalizeText($(el).find(".tnms").text());
    const prediction = normalizeText($(el).find(".predict").text());
    const probability = normalizeText($(el).find(".prob").text());
    const score = normalizeText($(el).find(".fprc").text());

    if (teams) {
      rows.push({
        source: "Forebet",
        source_url: "https://www.forebet.com",
        match: teams,
        prediction: prediction || "Sin dato",
        probability: probability || "N/A",
        score: score || "N/A",
      });
    }
  });

  return rows.slice(0, 20);
}

module.exports = {
  scrapeForebet,
};
