const logger = require("../utils/logger");
const { db } = require("../config/database");
const { callChatModel, isAiEnabled } = require("./aiForecastService");
const { createNews, hasMatupicksBlogForPick } = require("../models/newsModel");
const { formatDateInTimezone } = require("../utils/helpers");

const NEWS_TABLE = process.env.FACTORY_NEWS_TABLE || "news_articles";

function todayIsoDate() {
  return formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota");
}

function toSlug(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function siteBase() {
  const raw = (process.env.APP_PUBLIC_URL || process.env.VITE_SITE_URL || "https://matupicks.app").trim();
  if (!raw) return "https://matupicks.app";
  const u = raw.replace(/\/$/, "");
  return u.startsWith("http") ? u : `https://${u.replace(/^\/\//, "")}`;
}

function heroImageUrl(seed) {
  const pool = [
    "1574629810360-7efbbe195018",
    "1431324155629-1a6a1c2c33bb",
    "1522778119023-f5bc543d3afb",
    "1556056502-d37465d75908",
  ];
  let h = 0;
  const s = String(seed || "x");
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const id = pool[h % pool.length];
  return `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1200&q=80`;
}

async function listPicksForDate(matchDate) {
  const { data: free, error: ef } = await db
    .from("free_picks")
    .select("*")
    .eq("match_date", matchDate)
    .order("confidence", { ascending: false })
    .limit(30);
  if (ef) throw new Error(ef.message || "free_picks");
  const { data: vip, error: ev } = await db
    .from("vip_picks")
    .select("*")
    .eq("match_date", matchDate)
    .order("confidence", { ascending: false })
    .limit(30);
  if (ev) throw new Error(ev.message || "vip_picks");
  return { free: free || [], vip: vip || [] };
}

function normalizeStatus(s) {
  const x = String(s || "").toLowerCase();
  if (x === "won" || x === "ganada") return "won";
  if (x === "lost" || x === "perdida") return "lost";
  return "pending";
}

async function listEndedPicksCandidates(limit = 24) {
  const out = [];
  for (const { table, tier } of [
    { table: "free_picks", tier: "free" },
    { table: "vip_picks", tier: "vip" },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await db
      .from(table)
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) {
      logger.warn(`[blog] list ended ${table}: ${error.message}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const row of data || []) {
      const st = normalizeStatus(row.status);
      if (st !== "won" && st !== "lost") continue;
      out.push({ ...row, _tier: tier, _table: table, _norm: st });
    }
  }
  out.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return out.slice(0, limit * 2);
}

const BLOG_PREVIA_SYSTEM = [
  "Eres director editorial y SEO senior de MatuPicks (pronósticos deportivos).",
  "Respondes SOLO JSON válido, sin markdown.",
  "Artículos informativos de previa; sin prometer dinero ni resultados seguros.",
  "Incluye lectura táctica y contexto de liga; tono español latinoamericano.",
].join(" ");

const BLOG_RECAP_SYSTEM = [
  "Eres editor deportivo senior de MatuPicks.",
  "Respondes SOLO JSON válido, sin markdown.",
  "Artículos post-partido: resultado, lectura del encuentro, qué funcionó o no.",
  "Puedes sugerir un bloque opcional para insertar video de YouTube con un <div class=\"yt-embed\"> y data-youtube-url=\"URL\" (placeholder si no hay URL real).",
].join(" ");

function buildPreviaUserPrompt(rows, baseUrl) {
  const compact = rows.map((row) => ({
    pick_id: row.id,
    pick_tier: row._tier,
    league: row.league,
    local: row.team_a,
    visitante: row.team_b,
    pronostico: row.pick_text,
    confianza: row.confidence,
    cuota: row.odds,
    fecha_partido: row.match_date,
    link_pronostico: `${baseUrl}/pronosticos/${row.id}/${toSlug(`${row.team_a}-vs-${row.team_b}-${row.league}`)}`,
  }));
  return [
    "Genera una entrada de blog por cada ítem (previa antes del partido).",
    JSON.stringify({ partidos: compact }, null, 0),
    "",
    "Formato exacto:",
    '{ "articles": [ { "pick_id": "uuid", "pick_tier": "free"|"vip", "title": "...", "excerpt": "máx 220 caracteres", "html_content": "HTML sin script. Incluye <h2>, varios <p>, opcional <ul>. Debe incluir un CTA con enlace absoluto al pronóstico (usa link_pronostico del ítem).", "seo_title": "máx 60 caracteres", "seo_description": "máx 155 caracteres", "read_time": 4 } ] }',
    "Debes devolver un artículo por cada pick_id listado (mismo número de artículos que ítems).",
  ].join("\n");
}

function buildRecapUserPrompt(rows, baseUrl) {
  const compact = rows.map((row) => ({
    pick_id: row.id,
    pick_tier: row._tier,
    resultado_sistema: row._norm,
    league: row.league,
    local: row.team_a,
    visitante: row.team_b,
    pronostico: row.pick_text,
    link_pronostico: `${baseUrl}/pronosticos/${row.id}/${toSlug(`${row.team_a}-vs-${row.team_b}-${row.league}`)}`,
  }));
  return [
    "Genera una entrada de blog post-partido (crónica / análisis a frío) por cada ítem.",
    JSON.stringify({ partidos: compact }, null, 0),
    "",
    "Formato exacto:",
    '{ "articles": [ { "pick_id": "uuid", "pick_tier": "free"|"vip", "title": "...", "excerpt": "máx 220 caracteres", "html_content": "HTML sin script. Resume el partido, el resultado y la tesis del pronóstico. Incluye sección opcional con div data-youtube-url para insertar resumen en video. CTA final: <a href=LINK>Ver ficha del pronóstico</a>.", "seo_title": "...", "seo_description": "...", "read_time": 5, "youtube_url": null } ] }',
  ].join("\n");
}

/**
 * @param {string} matchDate YYYY-MM-DD
 * @param {number} maxArticles máximo de partidos distintos a cubrir
 */
async function generatePreviaBlogsForDate(matchDate, maxArticles = 4) {
  if (!isAiEnabled()) {
    return { skipped: true, reason: "ai_disabled", created: 0 };
  }
  const base = siteBase();
  const { free, vip } = await listPicksForDate(matchDate);
  const ranked = [
    ...vip.map((r) => ({ ...r, _tier: "vip" })),
    ...free.map((r) => ({ ...r, _tier: "free" })),
  ].sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0)));

  const candidates = [];
  const seenMatch = new Set();
  for (const row of ranked) {
    if (!row?.id || candidates.length >= maxArticles) break;
    const mk = `${String(row.team_a).toLowerCase()}|${String(row.team_b).toLowerCase()}`;
    if (seenMatch.has(mk)) continue;
    // eslint-disable-next-line no-await-in-loop
    const exists = await hasMatupicksBlogForPick(String(row.id), "previa");
    if (exists) continue;
    seenMatch.add(mk);
    candidates.push(row);
  }

  if (!candidates.length) {
    return { skipped: false, created: 0, message: "no_candidates", matchDate };
  }

  const userPrompt = buildPreviaUserPrompt(candidates, base);
  const raw = await callChatModel(userPrompt, BLOG_PREVIA_SYSTEM);
  const articles = Array.isArray(raw?.articles) ? raw.articles : [];
  let created = 0;

  for (const art of articles) {
    const pickId = String(art.pick_id || "").trim();
    const tier = art.pick_tier === "vip" ? "vip" : "free";
    const row = candidates.find((c) => String(c.id) === pickId);
    if (!row) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await hasMatupicksBlogForPick(pickId, "previa")) continue;
    const slug = `mp-previa-${toSlug(`${matchDate}-${row.team_a}-vs-${row.team_b}`)}`.slice(0, 120);
    try {
      // eslint-disable-next-line no-await-in-loop
      await createNews({
        slug,
        title: String(art.title || `Previa: ${row.team_a} vs ${row.team_b}`).slice(0, 200),
        summary: String(art.excerpt || art.seo_description || "").slice(0, 400),
        content: String(art.html_content || `<p>${String(art.excerpt || "")}</p>`),
        category: "pronosticos",
        image: heroImageUrl(pickId),
        read_time: Number.isFinite(Number(art.read_time)) ? Number(art.read_time) : 5,
        seo_title: art.seo_title ? String(art.seo_title).slice(0, 120) : null,
        seo_description: art.seo_description ? String(art.seo_description).slice(0, 200) : null,
        matupicks_pick_id: pickId,
        matupicks_pick_tier: tier,
        matupicks_blog_kind: "previa",
        matupicks_youtube_url: null,
      });
      created += 1;
    } catch (e) {
      logger.warn(`[blog] previa ${pickId}: ${e.message}`);
    }
  }

  return { skipped: false, created, matchDate, candidates: candidates.length, table: NEWS_TABLE };
}

/** Crónicas post-partido para picks ya cerrados (won/lost) sin recap. */
async function generateRecapBlogsOnce(maxPicks = 3) {
  if (!isAiEnabled()) {
    return { skipped: true, reason: "ai_disabled", created: 0 };
  }
  const base = siteBase();
  const pool = await listEndedPicksCandidates(40);
  const candidates = [];
  for (const row of pool) {
    if (candidates.length >= maxPicks) break;
    // eslint-disable-next-line no-await-in-loop
    const has = await hasMatupicksBlogForPick(String(row.id), "recap");
    if (has) continue;
    candidates.push(row);
  }
  if (!candidates.length) {
    return { skipped: false, created: 0, message: "no_recap_candidates" };
  }

  const userPrompt = buildRecapUserPrompt(candidates, base);
  const raw = await callChatModel(userPrompt, BLOG_RECAP_SYSTEM);
  const articles = Array.isArray(raw?.articles) ? raw.articles : [];
  let created = 0;

  for (const art of articles) {
    const pickId = String(art.pick_id || "").trim();
    const tier = art.pick_tier === "vip" ? "vip" : "free";
    const row = candidates.find((c) => String(c.id) === pickId);
    if (!row) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await hasMatupicksBlogForPick(pickId, "recap")) continue;
    const slug = `mp-recap-${toSlug(`${row.match_date}-${row.team_a}-vs-${row.team_b}`)}`.slice(0, 120);
    const yt = art.youtube_url ? String(art.youtube_url).trim() : "";
    try {
      // eslint-disable-next-line no-await-in-loop
      await createNews({
        slug,
        title: String(art.title || `Crónica: ${row.team_a} vs ${row.team_b}`).slice(0, 200),
        summary: String(art.excerpt || art.seo_description || "").slice(0, 400),
        content: String(art.html_content || `<p>${String(art.excerpt || "")}</p>`),
        category: "analisis",
        image: heroImageUrl(`${pickId}-recap`),
        read_time: Number.isFinite(Number(art.read_time)) ? Number(art.read_time) : 6,
        seo_title: art.seo_title ? String(art.seo_title).slice(0, 120) : null,
        seo_description: art.seo_description ? String(art.seo_description).slice(0, 200) : null,
        matupicks_pick_id: pickId,
        matupicks_pick_tier: tier,
        matupicks_blog_kind: "recap",
        matupicks_youtube_url: yt || null,
      });
      created += 1;
    } catch (e) {
      logger.warn(`[blog] recap ${pickId}: ${e.message}`);
    }
  }

  return { skipped: false, created, candidates: candidates.length };
}

module.exports = {
  generatePreviaBlogsForDate,
  generateRecapBlogsOnce,
  todayIsoDate,
  siteBase,
};
