const { db } = require("../config/database");

async function getNews(limit = 100) {
  const { data, error } = await db
    .from("sports_news")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(error.message || "Error obteniendo noticias");
  }
  return data || [];
}

async function createNews(news) {
  const { data, error } = await db.from("sports_news").insert({
    title: news.title,
    summary: news.summary,
    url: news.url,
    image: news.image,
    source: news.source,
  });
  if (error) {
    throw new Error(error.message || "Error creando noticia");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function getNewsByUrl(url) {
  const { data, error } = await db
    .from("sports_news")
    .select("*")
    .eq("url", url)
    .limit(1);
  if (error) {
    throw new Error(error.message || "Error buscando noticia por URL");
  }
  return data?.[0] || null;
}

async function createNewsIfNew(news) {
  const existing = await getNewsByUrl(news.url);
  if (existing) {
    return null;
  }
  return createNews(news);
}

module.exports = {
  getNews,
  createNews,
  getNewsByUrl,
  createNewsIfNew,
};
