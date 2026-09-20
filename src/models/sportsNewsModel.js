const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const axios = require("axios");
const { db } = require("../config/database");
const { getPublicBaseUrl } = require("../services/futboolLogoService");

const TABLE = "sports_news";
const NEWS_IMAGES_DIR = path.join(__dirname, "..", "..", "data", "news", "images");
const NEWS_PUBLIC_PREFIX = "/assets/news";

function ensureNewsDir() {
  fs.mkdirSync(NEWS_IMAGES_DIR, { recursive: true });
}

function slugify(title = "") {
  return String(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Descarga imagen remota → data/news/images y devuelve URL pública del API.
 */
async function downloadNewsImage(imageUrl, slugHint = "news") {
  const src = String(imageUrl || "").trim();
  if (!src || !/^https?:\/\//i.test(src)) return "";
  ensureNewsDir();
  try {
    const res = await axios.get(src, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: { "User-Agent": "MatuPicksBot/1.0" },
      maxRedirects: 5,
    });
    const ctype = String(res.headers["content-type"] || "");
    let ext = ".jpg";
    if (ctype.includes("png")) ext = ".png";
    else if (ctype.includes("webp")) ext = ".webp";
    else if (ctype.includes("gif")) ext = ".gif";
    const hash = crypto.createHash("md5").update(src).digest("hex").slice(0, 10);
    const file = `${slugify(slugHint) || "news"}-${hash}${ext}`;
    const abs = path.join(NEWS_IMAGES_DIR, file);
    fs.writeFileSync(abs, Buffer.from(res.data));
    return `${getPublicBaseUrl()}${NEWS_PUBLIC_PREFIX}/${file}`;
  } catch {
    return src.startsWith("http") ? src : "";
  }
}

async function sportsNewsTitleExists(title) {
  const t = String(title || "").trim();
  if (!t) return false;
  const { data, error } = await db.from(TABLE).select("id").eq("title", t).limit(1);
  if (error) throw new Error(error.message || "sports_news title lookup");
  return Boolean(data && data.length > 0);
}

async function insertSportsNewsRow(row) {
  const payload = {
    title: String(row.title || "").trim().slice(0, 300),
    summary: String(row.summary || row.title || "").trim().slice(0, 1200),
    content: String(row.content || row.summary || row.title || "").trim().slice(0, 20000),
    slug: String(row.slug || slugify(row.title) || "").slice(0, 120),
    url: String(row.url || "#").trim().slice(0, 2000),
    external_source_url: String(row.external_source_url || "").trim().slice(0, 2000),
    image: String(row.image || "").trim().slice(0, 2000),
    source: String(row.source || "MatuPicks").trim().slice(0, 120),
    updated_at: new Date().toISOString(),
  };
  if (!payload.title) return null;
  const { data, error } = await db.from(TABLE).insert(payload);
  if (error) {
    // columnas content/slug pueden no existir aún → insert mínimo
    const slim = {
      title: payload.title,
      summary: payload.summary,
      url: payload.url,
      image: payload.image,
      source: payload.source,
      updated_at: payload.updated_at,
    };
    const retry = await db.from(TABLE).insert(slim);
    if (retry.error) throw new Error(retry.error.message || "sports_news insert");
    return Array.isArray(retry.data) ? retry.data[0] : retry.data;
  }
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Guarda noticia PROPIA: contenido en BD + imagen local en nuestro API.
 * `url` apunta a recurso interno (no redirige al medio).
 */
async function appendOwnedNews(item) {
  const title = String(item.title || "").trim();
  if (!title) return null;
  if (await sportsNewsTitleExists(title)) return null;

  const slug = slugify(title) || `n-${Date.now()}`;
  const localImage = await downloadNewsImage(item.image, slug);
  const content = String(item.content || item.summary || title).trim();
  const summary = String(item.summary || content).trim().slice(0, 600);

  return insertSportsNewsRow({
    title,
    summary,
    content,
    slug,
    // URL interna: la app lee el artículo desde MatuDB, no del medio
    url: `#/noticias/${slug}`,
    external_source_url: item.url || "",
    image: localImage || item.image || "",
    source: item.source || "MatuPicks",
  });
}

/** @deprecated usar appendOwnedNews */
async function appendScrapedToSportsNews(item) {
  return appendOwnedNews(item);
}

async function countMatuPicksFeedSinceHours(hours) {
  const h = Math.min(48, Math.max(1, Number(hours) || 12));
  const since = new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from(TABLE).select("id").eq("source", "MatuPicks").gte("created_at", since).limit(80);
  if (error) return 0;
  return (data || []).length;
}

async function getSportsNews(limit = 50) {
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message || "Error obteniendo sports_news");
  return data || [];
}

module.exports = {
  TABLE,
  NEWS_IMAGES_DIR,
  NEWS_PUBLIC_PREFIX,
  insertSportsNewsRow,
  appendOwnedNews,
  appendScrapedToSportsNews,
  countMatuPicksFeedSinceHours,
  getSportsNews,
  downloadNewsImage,
  slugify,
};
