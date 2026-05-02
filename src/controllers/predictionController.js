const {
  getFreePredictions,
  createFreePrediction,
  updateFreePredictionState,
  updateFreeModerationStatus,
  getFreeSummaryToday,
} = require("../models/predictionModel");
const { db } = require("../config/database");
const { sendMessage } = require("../config/whatsapp");

function buildWhatsappMessage(prediction) {
  return `⚽ PRONOSTICO DEL DIA

${prediction.home_team_name || prediction.team_a || prediction.homeTeam?.name} vs ${
    prediction.away_team_name || prediction.team_b || prediction.awayTeam?.name
  }

Pronostico:
${prediction.prediction || prediction.pick_text}

Confianza:
${prediction.confidence}%

Cuota:
${prediction.odds}

Resumen:
${prediction.rationale_short || "Consenso estadístico del día."}`;
}

async function listFreePredictions(req, res, next) {
  try {
    const rawLimit = Number.parseInt(String(req.query.limit || "100"), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(400, Math.max(1, rawLimit)) : 100;
    const rows = await getFreePredictions(limit, {
      todayOnly: req.query.today === "true",
      sport: req.query.sport,
      date: req.query.date,
      moderationStatus: req.query.moderation || "active",
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

async function createPrediction(req, res, next) {
  try {
    const prediction = await createFreePrediction(req.body);
    const to = process.env.WHATSAPP_PHONE_FREE;
    if (to) {
      await sendMessage(to, buildWhatsappMessage(prediction));
    }
    res.status(201).json(prediction);
  } catch (error) {
    next(error);
  }
}

async function updateFreeState(req, res, next) {
  try {
    const row = await updateFreePredictionState(req.params.id, req.body.state);
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function updateFreeModeration(req, res, next) {
  try {
    const moderation = String(req.body.moderation_status || "").toLowerCase();
    if (!["pending", "active", "rejected"].includes(moderation)) {
      return res.status(400).json({ error: "moderation_status inválido" });
    }
    const row = await updateFreeModerationStatus(
      req.params.id,
      moderation,
      req.body.moderation_note || null
    );
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function getFreeDailySummary(req, res, next) {
  try {
    const summary = await getFreeSummaryToday();
    res.json(summary);
  } catch (error) {
    next(error);
  }
}

function slugToken(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSeoSlug(home, away, league) {
  const parts = [slugToken(home), "vs", slugToken(away), slugToken(league)].filter(Boolean);
  return parts.join("-") || "pronostico-del-partido";
}

function toSeoUrlRow(row) {
  const id = row?.id != null ? String(row.id) : "";
  if (!id) return null;
  const home = row.home_team_name || row.team_a || row.home_team || "local";
  const away = row.away_team_name || row.team_b || row.away_team || "visitante";
  const league = row.league || row.competition || "futbol";
  return {
    id,
    slug: buildSeoSlug(home, away, league),
    matchDate: row.match_date || null,
    updatedAt: row.updated_at || row.created_at || null,
  };
}

async function getSeoUrls(req, res, next) {
  try {
    const rawLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 50), 2000) : 500;
    const urlEntries = await buildSeoUrlEntries(limit);
    return res.json({
      total: Math.min(urlEntries.length, limit),
      urls: urlEntries.slice(0, limit),
    });
  } catch (error) {
    return next(error);
  }
}

function getAppBaseUrl() {
  return String(process.env.APP_PUBLIC_URL || "https://matupicks.app").replace(/\/+$/, "");
}

function getApiBaseUrl(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  if (host) return `${proto}://${host}`.replace(/\/+$/, "");
  return getAppBaseUrl();
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function buildSeoUrlEntries(limit, options = {}) {
    const includeStandard = options.includeStandard !== false;
    const includeLive = options.includeLive !== false;
    const includeBlog = options.includeBlog === true;
    /** Dedupe por URL path (abetlive usa `/pronosticos/live/...`). */
    const seenPath = new Set();
    const urlEntries = [];

    function pushStandard(row) {
      const mapped = toSeoUrlRow(row);
      if (!mapped) return;
      const path = `/pronosticos/${encodeURIComponent(mapped.id)}/${mapped.slug}`;
      if (seenPath.has(path)) return;
      seenPath.add(path);
      urlEntries.push({
        path,
        lastmod: mapped.updatedAt || undefined,
        matchDate: mapped.matchDate || undefined,
      });
    }

    /** Misma lógica de slug que el front: `buildSeoSlug(home, away, league + ' live')`. */
    function pushLive(row) {
      const id = row?.id != null ? String(row.id) : "";
      if (!id) return;
      const home = row.home_team_name || row.team_a || "local";
      const away = row.away_team_name || row.team_b || "visitante";
      const league = row.league || row.competition || "futbol";
      const slug = buildSeoSlug(home, away, `${league} live`);
      const path = `/pronosticos/live/${encodeURIComponent(id)}/${slug}`;
      if (seenPath.has(path)) return;
      seenPath.add(path);
      urlEntries.push({
        path,
        lastmod: row.updated_at || row.created_at || undefined,
        matchDate: row.match_date || undefined,
      });
    }

    if (includeStandard) {
      const tables = ["abet", "abetvip", "free_picks", "vip_picks"];
      for (const table of tables) {
        const q = db
          .from(table)
          .select("id,league,home_team_name,away_team_name,team_a,team_b,match_date,created_at,updated_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        const { data, error } = await q;
        if (error) continue;
        for (const row of data || []) {
          pushStandard(row);
        }
      }
    }

    if (includeLive) {
      const liveQ = await db
        .from("abetlive")
        .select("id,league,home_team_name,away_team_name,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (!liveQ.error) {
        for (const row of liveQ.data || []) {
          pushLive(row);
        }
      }
    }

    if (includeBlog) {
      const blogQ = await db
        .from("news_articles")
        .select("slug,updated_at,published_at,matupicks_blog_kind")
        .order("published_at", { ascending: false })
        .limit(limit);
      if (!blogQ.error) {
        for (const row of blogQ.data || []) {
          const slug = String(row.slug || "").trim();
          if (!slug) continue;
          const kind = String(row.matupicks_blog_kind || "").trim();
          const path =
            kind === "previa" || kind === "recap"
              ? `/previas/${encodeURIComponent(slug)}`
              : `/news/${encodeURIComponent(slug)}`;
          if (seenPath.has(path)) continue;
          seenPath.add(path);
          urlEntries.push({
            path,
            lastmod: row.updated_at || row.published_at || undefined,
          });
        }
      }
    }

    return urlEntries;
}

function toSitemapXml(base, entries) {
  const body = entries
    .map((u) => {
      const loc = `${base}${u.path}`;
      const lastmod = String(u.lastmod || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const freq = u.path.includes("/predictions/live") || u.path.includes("/pronosticos/live/") ? "hourly" : "daily";
      return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${escapeXml(lastmod)}</lastmod>
    <changefreq>${freq}</changefreq>
    <priority>${u.path === "/" ? "1.0" : "0.8"}</priority>
  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}

async function getSeoSitemapXml(req, res, next) {
  try {
    const base = getAppBaseUrl();
    const rawLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 50), 5000) : 2000;
    const entries = await buildSeoUrlEntries(limit, { includeStandard: true, includeLive: true, includeBlog: true });
    const staticPaths = [
      "/",
      "/predictions/free",
      "/predictions/vip",
      "/predictions/live",
      "/news",
      "/previas",
      "/como-funciona",
      "/estrategias-apuestas",
      "/estadisticas-futbol",
      "/glosario-apuestas",
      "/sobre-matupicks",
    ];
    const staticEntries = staticPaths.map((path) => ({ path, lastmod: new Date().toISOString().slice(0, 10) }));
    const merged = [...staticEntries, ...entries, { path: "/news", lastmod: new Date().toISOString().slice(0, 10) }];
    const seen = new Set();
    const unique = merged.filter((u) => {
      const p = String(u.path || "").trim();
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    });
    const xml = toSitemapXml(base, unique);
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(xml);
  } catch (error) {
    return next(error);
  }
}

async function getSeoSitemapPronosticosXml(req, res, next) {
  try {
    const base = getAppBaseUrl();
    const rawLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 50), 5000) : 3000;
    const entries = await buildSeoUrlEntries(limit, { includeStandard: true, includeLive: false, includeBlog: false });
    const xml = toSitemapXml(base, entries);
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(xml);
  } catch (error) {
    return next(error);
  }
}

async function getSeoSitemapLiveXml(req, res, next) {
  try {
    const base = getAppBaseUrl();
    const rawLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 50), 5000) : 3000;
    const entries = await buildSeoUrlEntries(limit, { includeStandard: false, includeLive: true, includeBlog: false });
    const xml = toSitemapXml(base, entries);
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(xml);
  } catch (error) {
    return next(error);
  }
}

async function getSeoSitemapBlogXml(req, res, next) {
  try {
    const base = getAppBaseUrl();
    const rawLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 50), 5000) : 3000;
    const entries = await buildSeoUrlEntries(limit, { includeStandard: false, includeLive: false, includeBlog: true });
    const xml = toSitemapXml(base, entries);
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(xml);
  } catch (error) {
    return next(error);
  }
}

async function getSeoSitemapIndexXml(req, res, next) {
  try {
    const apiBase = getApiBaseUrl(req);
    const today = new Date().toISOString().slice(0, 10);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${escapeXml(`${apiBase}/api/predictions/seo/sitemap-pronosticos.xml`)}</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${escapeXml(`${apiBase}/api/predictions/seo/sitemap-live.xml`)}</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${escapeXml(`${apiBase}/api/predictions/seo/sitemap-blog.xml`)}</loc>
    <lastmod>${today}</lastmod>
  </sitemap>
</sitemapindex>`;
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(xml);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listFreePredictions,
  createPrediction,
  updateFreeState,
  updateFreeModeration,
  getFreeDailySummary,
  getSeoUrls,
  getSeoSitemapXml,
  getSeoSitemapPronosticosXml,
  getSeoSitemapLiveXml,
  getSeoSitemapBlogXml,
  getSeoSitemapIndexXml,
};
