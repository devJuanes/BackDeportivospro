const { getNews } = require("../models/newsModel");
const { toNewsJson, apiOk } = require("../utils/predictionDto");

async function listNews(req, res, next) {
  try {
    const rows = await getNews(100);
    res.json(apiOk(rows.map(toNewsJson), { total: rows.length }));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listNews,
};
