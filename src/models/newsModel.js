const { db } = require("../config/database");
const NEWS_TABLE = process.env.FACTORY_NEWS_TABLE || "news_articles";

function toSlug(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function getNews(limit = 100) {
  const { data, error } = await db
    .from(NEWS_TABLE)
    .select("*")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(error.message || "Error obteniendo noticias");
  }
  return data || [];
}

async function createNews(news) {
  const slug = toSlug(news.slug || news.title || "noticia");
  const excerpt = news.summary || news.excerpt || "Actualización deportiva.";
  const content = news.content || news.summary || excerpt;
  const row = {
    slug,
    title: news.title,
    excerpt,
    content,
    category: news.category || "noticias",
    image_url: news.image,
    author: news.author || "Equipo MatuPicks",
    read_time: Number.isInteger(news.read_time) ? news.read_time : 5,
    featured: news.featured === true,
    seo_title: news.seo_title || null,
    seo_description: news.seo_description || null,
  };
  if (news.matupicks_pick_id) row.matupicks_pick_id = news.matupicks_pick_id;
  if (news.matupicks_pick_tier) row.matupicks_pick_tier = news.matupicks_pick_tier;
  if (news.matupicks_blog_kind) row.matupicks_blog_kind = news.matupicks_blog_kind;
  if (news.matupicks_youtube_url) row.matupicks_youtube_url = news.matupicks_youtube_url;
  const { data, error } = await db.from(NEWS_TABLE).insert(row);
  if (error) {
    throw new Error(error.message || "Error creando noticia");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function getNewsBySlug(slug) {
  const { data, error } = await db
    .from(NEWS_TABLE)
    .select("*")
    .eq("slug", slug)
    .limit(1);
  if (error) {
    throw new Error(error.message || "Error buscando noticia por slug");
  }
  return data?.[0] || null;
}

async function createNewsIfNew(news) {
  const existing = await getNewsBySlug(toSlug(news.slug || news.title || "noticia"));
  if (existing) {
    return null;
  }
  return createNews(news);
}

async function listMatupicksBlogPosts(limit = 30) {
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const { data, error } = await db
    .from(NEWS_TABLE)
    .select("*")
    .or("matupicks_blog_kind.eq.previa,matupicks_blog_kind.eq.recap")
    .order("published_at", { ascending: false })
    .limit(lim);
  if (error) {
    throw new Error(error.message || "Error listando blog MatuPicks");
  }
  return data || [];
}

async function hasMatupicksBlogForPick(pickId, kind) {
  const clean = String(pickId || "").trim();
  const k = String(kind || "").trim();
  if (!clean || !k) return false;
  const { data, error } = await db
    .from(NEWS_TABLE)
    .select("id")
    .eq("matupicks_pick_id", clean)
    .eq("matupicks_blog_kind", k)
    .limit(1);
  if (error) {
    return false;
  }
  return Boolean(data && data.length > 0);
}

module.exports = {
  getNews,
  createNews,
  getNewsBySlug,
  createNewsIfNew,
  listMatupicksBlogPosts,
  hasMatupicksBlogForPick,
};
