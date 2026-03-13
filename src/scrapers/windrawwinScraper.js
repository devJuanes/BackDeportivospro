const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeText } = require("../utils/helpers");

async function scrapeWinDrawWin() {
  const url = "https://www.windrawwin.com/predictions/";
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

  $(".predictions-table tr").each((_, el) => {
    const match = normalizeText($(el).find("td:nth-child(2)").text());
    const prediction = normalizeText($(el).find("td:nth-child(4)").text());
    const score = normalizeText($(el).find("td:nth-child(5)").text());
    const probability = normalizeText($(el).find("td:nth-child(6)").text());

    if (match) {
      rows.push({
        source: "Windrawwin",
        source_url: "https://www.windrawwin.com",
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
  scrapeWinDrawWin,
};
