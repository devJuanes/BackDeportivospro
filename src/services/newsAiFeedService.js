const logger = require("../utils/logger");
const { db } = require("../config/database");
const { callChatModel, isAiEnabled } = require("./aiForecastService");
const {
  insertSportsNewsRow,
  sportsNewsTitleExists,
  countMatuPicksFeedSinceHours,
} = require("../models/sportsNewsModel");
const { formatDateInTimezone } = require("../utils/helpers");

function todayIsoDate() {
  return formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota");
}

function siteBase() {
  const raw = (process.env.APP_PUBLIC_URL || process.env.VITE_SITE_URL || "https://matupicks.app").trim();
  if (!raw) return "https://matupicks.app";
  const u = raw.replace(/\/$/, "");
  return u.startsWith("http") ? u : `https://${u.replace(/^\/\//, "")}`;
}

const HERO_ROTATION = [
  "1574629810360-7efbbe195018",
  "1431324155629-1a6a1c2c33bb",
  "1522778119023-f5bc543d3afb",
  "1556056502-d37465d75908",
];

function heroForIndex(i) {
  const id = HERO_ROTATION[i % HERO_ROTATION.length];
  return `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=800&q=80`;
}

async function loadTodayMatchesContext(limit = 10) {
  const day = todayIsoDate();
  const out = [];
  for (const table of ["vip_picks", "free_picks"]) {
    const { data, error } = await db
      .from(table)
      .select("team_a, team_b, league, match_date, pick_text")
      .eq("match_date", day)
      .order("confidence", { ascending: false })
      .limit(limit);
    if (error) {
      logger.warn(`[news-ai] context ${table}: ${error.message}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const row of data || []) {
      out.push({
        local: row.team_a,
        visita: row.team_b,
        liga: row.league,
        fecha: row.match_date,
        lectura: row.pick_text,
      });
    }
  }
  return out.slice(0, limit);
}

const NEWS_FEED_SYSTEM = [
  "Eres editor del feed deportivo de MatuPicks (app de pronósticos en español latinoamericano).",
  "Respondes SOLO JSON válido, sin markdown.",
  "No inventes fichajes, lesiones ni sanciones concretas de personas reales salvo que consten en el contexto.",
  "Si el contexto de partidos está vacío, escribe notas genéricas de agenda, forma y lectura de mercados (sin nombres inventados).",
  "Cada nota debe sonar a titular de app móvil: clara, breve, sin sensacionalismo ilegal ni promesas de ganancia.",
].join(" ");

/**
 * Genera notas cortas para `sports_news` (feed /news del frontend).
 * @returns {Promise<Array<{ id?: string }>>} filas creadas
 */
async function generateAndAppendAiFeed() {
  if (!isAiEnabled()) {
    return [];
  }
  const recent = await countMatuPicksFeedSinceHours(
    Number.parseInt(process.env.FACTORY_AI_NEWS_COOLDOWN_HOURS || "8", 10) || 8,
  );
  const maxPerWindow = Number.parseInt(process.env.FACTORY_AI_NEWS_MAX_PER_WINDOW || "6", 10) || 6;
  if (recent >= maxPerWindow) {
    return [];
  }

  const matches = await loadTodayMatchesContext(10);
  const base = siteBase();
  const userPrompt = [
    `Fecha calendario fábrica: ${todayIsoDate()}.`,
    "Partidos y lecturas disponibles (JSON; puede estar vacío):",
    JSON.stringify({ partidos_hoy: matches }),
    "",
    "Genera entre 4 y 6 notas para un feed móvil.",
    "Al menos 2 deben incluir la palabra previa (minúsculas) en título o resumen para filtro de pestaña.",
    "Al menos 1 debe incluir fichaje o mercado en título o resumen.",
    "Al menos 1 debe incluir lesión o baja en título o resumen (solo si encaja con el contexto; si no, habla de bajas en sentido genérico).",
    "",
    'Formato: { "items": [ { "title": "máx 90 chars", "summary": "máx 200 chars" } ] }',
    `Todas las notas llevan enlace interno sugerido: ${base}/predictions/free (no lo repitas en el JSON; el servidor lo asigna).`,
  ].join("\n");

  let raw;
  try {
    raw = await callChatModel(userPrompt, NEWS_FEED_SYSTEM);
  } catch (e) {
    logger.warn(`[news-ai] modelo: ${e.message}`);
    return [];
  }

  const items = Array.isArray(raw?.items) ? raw.items : [];
  const created = [];
  let idx = 0;
  for (const it of items) {
    const title = String(it.title || "").trim();
    const summary = String(it.summary || title).trim();
    if (!title) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await sportsNewsTitleExists(title)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await insertSportsNewsRow({
        title,
        summary,
        url: `${base}/predictions/free`,
        image: heroForIndex(idx),
        source: "MatuPicks",
      });
      if (row) created.push(row);
      idx += 1;
    } catch (e) {
      logger.warn(`[news-ai] insert: ${e.message}`);
    }
  }

  if (created.length) {
    logger.info(`[news-ai] sports_news creadas: ${created.length}`);
  }
  return created;
}

module.exports = {
  generateAndAppendAiFeed,
};
