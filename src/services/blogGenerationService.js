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

/** Imagen por defecto del propio sitio (evita Unsplash roto / repetido en cards). Staff puede sustituir URL en Fábrica. */
function defaultArticleHeroUrl() {
  return `${siteBase()}/og-banner.png`;
}

function pickHeroImageUrl(art) {
  const u = String(art?.hero_image_url || "").trim();
  if (u.startsWith("https://") || u.startsWith("http://")) return u;
  return defaultArticleHeroUrl();
}

function readTimeFromHtml(html, fallback = 10) {
  const len = String(html || "").length;
  const est = Math.round(len / 1100);
  return Math.min(18, Math.max(8, Number.isFinite(est) ? est : fallback));
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
  "Eres director editorial y SEO senior de MatuPicks (pronósticos deportivos, Latinoamérica y Europa).",
  "Respondes SOLO JSON válido, sin markdown envolvente.",
  "Artículos largos de previa: mínimo ~900 palabras en html_content (varios <h2>, <h3>, <p>, <ul> con datos).",
  "Incluye secciones claras: (1) contexto de liga y jornada, (2) forma reciente ilustrativa local vs visita, (3) enfrentamientos / estilo de juego, (4) ausencias o dudas si aplican al contexto, (5) lectura táctica y ritmo esperado, (6) mercados relacionados con el pronóstico del pick (sin prometer ganancias), (7) datos a vigilar con lista.",
  "Puedes usar números y rachas como EJEMPLO ilustrativo; añade una frase de descargo: son referencias editoriales, no certificación estadística externa.",
  "Debe existir un CTA visible: botón o enlace destacado al link_pronostico del ítem (HTML <a> con href absoluto).",
  "hero_image_url: URL https pública de imagen horizontal (estadio, gráfico genérico). Si no tienes una fiable, usa null.",
  "Tono español latinoamericano; sin lenguaje de apuesta problemática ni promesas de resultado.",
].join(" ");

const BLOG_RECAP_SYSTEM = [
  "Eres editor deportivo senior de MatuPicks.",
  "Respondes SOLO JSON válido, sin markdown envolvente.",
  "Crónicas largas post-partido: mínimo ~700 palabras en html_content con <h2>, <p>, listas donde encaje.",
  "Estructura: resultado y lectura del ritmo, claves tácticas que marcaron, acierto o error del pronóstico enlazado, qué esperar a futuro.",
  "Puedes sugerir un bloque opcional para video: <div class=\"yt-embed\" data-youtube-url=\"URL\"> si hay URL; si no, omite.",
  "hero_image_url: URL https de imagen; si no hay una fiable, null.",
  "Incluye CTA final con enlace absoluto a la ficha del pronóstico.",
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
    "Formato exacto (respeta las claves):",
    '{ "articles": [ { "pick_id": "uuid", "pick_tier": "free"|"vip", "title": "...", "excerpt": "220-380 caracteres; resumen rico, no una sola frase", "html_content": "HTML sin <script>. Largo editorial (~900+ palabras), secciones con <h2>/<h3>, listas <ul>, negritas <strong> en datos clave. Incluye CTA al link_pronostico.", "seo_title": "máx 60 caracteres", "seo_description": "130-160 caracteres", "read_time": 10, "hero_image_url": "https://... o null" } ] }',
    "Devuelve exactamente un artículo por cada pick_id listado (mismo orden y cantidad).",
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
    '{ "articles": [ { "pick_id": "uuid", "pick_tier": "free"|"vip", "title": "...", "excerpt": "220-360 caracteres", "html_content": "HTML sin <script>. ~700+ palabras, <h2>/<h3>, análisis del resultado y del pick enlazado. CTA con href absoluto a link_pronostico.", "seo_title": "...", "seo_description": "...", "read_time": 9, "youtube_url": null, "hero_image_url": "https://... o null" } ] }',
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
  ].sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));

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
  const blogTimeoutMs = Number.parseInt(process.env.BLOG_AI_TIMEOUT_MS || "180000", 10);
  const raw = await callChatModel(userPrompt, BLOG_PREVIA_SYSTEM, { timeoutMs: blogTimeoutMs });
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
      const htmlBody = String(art.html_content || "").trim();
      const excerptFallback = String(art.excerpt || art.seo_description || "").trim();
      const content =
        htmlBody.length >= 400
          ? htmlBody
          : `${htmlBody}<p>${excerptFallback}</p><p><em>Contenido ampliado pendiente: usá la Fábrica → Editor de notas para pegar HTML o subir más texto.</em></p>`;
      await createNews({
        slug,
        title: String(art.title || `Previa: ${row.team_a} vs ${row.team_b}`).slice(0, 200),
        summary: excerptFallback.slice(0, 400) || excerptFallback,
        content,
        category: "pronosticos",
        image: pickHeroImageUrl(art),
        read_time: Number.isFinite(Number(art.read_time))
          ? Math.min(20, Math.max(8, Number(art.read_time)))
          : readTimeFromHtml(content),
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

async function fetchPickRowById(pickId, tier) {
  const table = tier === "vip" ? "vip_picks" : "free_picks";
  const { data, error } = await db.from(table).select("*").eq("id", pickId).limit(1);
  if (error) throw new Error(error.message || table);
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows[0] || null;
}

/**
 * Genera una sola previa de blog para un pick concreto (admin / cron).
 * @param {string} pickId uuid del pick en free_picks o vip_picks
 * @param {"free"|"vip"} tier
 */
async function generatePreviaBlogForPick(pickId, tier) {
  if (!isAiEnabled()) {
    return { skipped: true, reason: "ai_disabled", created: 0 };
  }
  const cleanTier = tier === "vip" ? "vip" : "free";
  const cleanId = String(pickId || "").trim();
  if (!cleanId) {
    return { skipped: false, created: 0, message: "missing_pick_id" };
  }
  const row = await fetchPickRowById(cleanId, cleanTier);
  if (!row) {
    return { skipped: false, created: 0, message: "pick_not_found" };
  }
  if (await hasMatupicksBlogForPick(cleanId, "previa")) {
    return { skipped: false, created: 0, message: "previa_already_exists" };
  }

  const base = siteBase();
  const candidates = [{ ...row, _tier: cleanTier }];
  const userPrompt = buildPreviaUserPrompt(candidates, base);
  const blogTimeoutMs = Number.parseInt(process.env.BLOG_AI_TIMEOUT_MS || "180000", 10);
  const raw = await callChatModel(userPrompt, BLOG_PREVIA_SYSTEM, { timeoutMs: blogTimeoutMs });
  const articles = Array.isArray(raw?.articles) ? raw.articles : [];
  let created = 0;
  const matchDateForSlug = String(row.match_date || todayIsoDate()).slice(0, 10);

  for (const art of articles) {
    const pickIdArt = String(art.pick_id || "").trim();
    const tierArt = art.pick_tier === "vip" ? "vip" : "free";
    if (pickIdArt !== cleanId || tierArt !== cleanTier) continue;
    if (await hasMatupicksBlogForPick(cleanId, "previa")) break;
    const slug = `mp-previa-${toSlug(`${matchDateForSlug}-${row.team_a}-vs-${row.team_b}`)}`.slice(0, 120);
    try {
      const htmlBody = String(art.html_content || "").trim();
      const excerptFallback = String(art.excerpt || art.seo_description || "").trim();
      const content =
        htmlBody.length >= 400
          ? htmlBody
          : `${htmlBody}<p>${excerptFallback}</p><p><em>Contenido ampliado pendiente: usá el Editor editorial para pegar HTML o subir más texto.</em></p>`;
      await createNews({
        slug,
        title: String(art.title || `Previa: ${row.team_a} vs ${row.team_b}`).slice(0, 200),
        summary: excerptFallback.slice(0, 400) || excerptFallback,
        content,
        category: "pronosticos",
        image: pickHeroImageUrl(art),
        read_time: Number.isFinite(Number(art.read_time))
          ? Math.min(20, Math.max(8, Number(art.read_time)))
          : readTimeFromHtml(content),
        seo_title: art.seo_title ? String(art.seo_title).slice(0, 120) : null,
        seo_description: art.seo_description ? String(art.seo_description).slice(0, 200) : null,
        matupicks_pick_id: cleanId,
        matupicks_pick_tier: cleanTier,
        matupicks_blog_kind: "previa",
        matupicks_youtube_url: null,
      });
      created = 1;
    } catch (e) {
      logger.warn(`[blog] previa pick ${cleanId}: ${e.message}`);
    }
  }

  return {
    skipped: false,
    created,
    pick_id: cleanId,
    tier: cleanTier,
    message: created ? "ok" : "no_article_in_response",
    table: NEWS_TABLE,
  };
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
  const blogTimeoutMs = Number.parseInt(process.env.BLOG_AI_TIMEOUT_MS || "180000", 10);
  const raw = await callChatModel(userPrompt, BLOG_RECAP_SYSTEM, { timeoutMs: blogTimeoutMs });
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
      const htmlRec = String(art.html_content || "").trim();
      const exRec = String(art.excerpt || art.seo_description || "").trim();
      const contentRec =
        htmlRec.length >= 350
          ? htmlRec
          : `${htmlRec}<p>${exRec}</p><p><em>Ampliá la crónica desde Fábrica → Editor de notas si querés más detalle.</em></p>`;
      await createNews({
        slug,
        title: String(art.title || `Crónica: ${row.team_a} vs ${row.team_b}`).slice(0, 200),
        summary: exRec.slice(0, 400) || exRec,
        content: contentRec,
        category: "analisis",
        image: pickHeroImageUrl(art),
        read_time: Number.isFinite(Number(art.read_time))
          ? Math.min(20, Math.max(8, Number(art.read_time)))
          : readTimeFromHtml(contentRec, 9),
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
  generatePreviaBlogForPick,
  generateRecapBlogsOnce,
  todayIsoDate,
  siteBase,
};
