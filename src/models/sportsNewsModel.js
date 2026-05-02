const { db } = require("../config/database");

const TABLE = "sports_news";

async function sportsNewsUrlExists(url) {
  const u = String(url || "").trim();
  if (!u || u === "#") return false;
  const { data, error } = await db.from(TABLE).select("id").eq("url", u).limit(1);
  if (error) throw new Error(error.message || "sports_news url lookup");
  return Boolean(data && data.length > 0);
}

async function sportsNewsTitleExists(title) {
  const t = String(title || "").trim();
  if (!t) return false;
  const { data, error } = await db.from(TABLE).select("id").eq("title", t).limit(1);
  if (error) throw new Error(error.message || "sports_news title lookup");
  return Boolean(data && data.length > 0);
}

/**
 * Inserta fila en `sports_news` (lo que consume el frontend MatuPicks).
 * @param {{ title: string, summary?: string, url?: string, image?: string, source?: string }} row
 */
async function insertSportsNewsRow(row) {
  const payload = {
    title: String(row.title || "").trim().slice(0, 300),
    summary: String(row.summary || row.title || "").trim().slice(0, 600),
    url: String(row.url || "#").trim().slice(0, 2000),
    image: String(row.image || "").trim().slice(0, 2000),
    source: String(row.source || "MatuPicks").trim().slice(0, 120),
    updated_at: new Date().toISOString(),
  };
  if (!payload.title) {
    return null;
  }
  const { data, error } = await db.from(TABLE).insert(payload);
  if (error) {
    throw new Error(error.message || "sports_news insert");
  }
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Noticias externas (scraper): evita duplicar por URL.
 */
async function appendScrapedToSportsNews(item) {
  const url = String(item.url || "").trim();
  if (!url) return null;
  if (await sportsNewsUrlExists(url)) return null;
  return insertSportsNewsRow({
    title: item.title,
    summary: item.summary || item.title,
    url,
    image: item.image || "",
    source: item.source || "Externo",
  });
}

async function countMatuPicksFeedSinceHours(hours) {
  const h = Math.min(48, Math.max(1, Number(hours) || 12));
  const since = new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from(TABLE).select("id").eq("source", "MatuPicks").gte("created_at", since).limit(80);
  if (error) {
    return 0;
  }
  return (data || []).length;
}

module.exports = {
  insertSportsNewsRow,
  appendScrapedToSportsNews,
  sportsNewsTitleExists,
  sportsNewsUrlExists,
  countMatuPicksFeedSinceHours,
};
