const { getNews } = require("../models/newsModel");

async function listNews(req, res, next) {
  try {
    const rows = await getNews(100);
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listNews,
};
