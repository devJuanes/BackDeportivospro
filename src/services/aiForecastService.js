const axios = require("axios");
const { estimateOddsFromConfidence } = require("./oddsService");
const { clamp } = require("../utils/helpers");
const logger = require("../utils/logger");
const { mergeDedupeByKey, normalizePickLabel } = require("../utils/predictionDedupe");

function isAiEnabled() {
  return process.env.FACTORY_AI_ENABLED === "true";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSlug(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function looksLikeDrawNoBet(pick = "") {
  const s = String(pick).toLowerCase();
  return (
    s.includes("draw no bet") ||
    s.includes("empate anulado") ||
    s.includes("empate no cuenta") ||
    /\bdnb\b/.test(s) ||
    (s.includes("sin empate") && s.includes("local"))
  );
}

function sanitizePick(pick, tier, fixture) {
  const raw = String(pick || "").trim();
  if (!raw || looksLikeDrawNoBet(raw)) {
    const home = fixture?.homeTeam || "local";
    return tier === "vip"
      ? `Victoria ${home} — mercado 1X2`
      : "Más de 1.5 goles";
  }
  return raw;
}

function buildPrompt(fixture) {
  const marketsPerMatch = Number.parseInt(process.env.FACTORY_MARKETS_PER_MATCH || "1", 10);
  return [
    "Eres un analista deportivo experto.",
    "Debes responder SOLO JSON válido sin markdown.",
    `Genera ${marketsPerMatch} pronósticos FREE y ${marketsPerMatch} VIP para el partido.`,
    "Usa mercados distintos y racionales para cada lista.",
    "Mercados con valor: 1X2 (local/visitante/empate explícito), hándicap asiático, over/under goles (líneas claras), ambos marcan, córners/tarjetas, combinadas justificadas.",
    "NO uses Draw No Bet, empate anulado ni variantes DNB: son cuotas planas y bajo valor percibido; el usuario espera picks con más upside.",
    "Incluye SEO orientado a búsquedas en Google.",
    "",
    `Partido: ${fixture.homeTeam} vs ${fixture.awayTeam}`,
    `Liga: ${fixture.league}`,
    `Deporte: ${fixture.sport}`,
    `Fecha: ${fixture.match_date}`,
    `Hora: ${fixture.match_hour}`,
    "",
    "Formato exacto JSON:",
    '{ "free": [ { "pick": "...", "confidence": 0-100, "analysis": "...", "seo_title": "...", "seo_description": "..." } ],',
    '  "vip": [ { "pick": "...", "confidence": 0-100, "analysis": "...", "seo_title": "...", "seo_description": "..." } ] }',
  ].join("\n");
}

function toPredictionRecord(fixture, tier, aiData, index = 0) {
  const confidenceBase = tier === "vip" ? 72 : 62;
  const confidence = clamp(
    Number.isFinite(aiData?.confidence) ? Number(aiData.confidence) : confidenceBase,
    tier === "vip" ? 65 : 55,
    tier === "vip" ? 93 : 82
  );
  const homeName = fixture?.homeTeam || "local";
  const fallbackPick =
    tier === "vip" ? `Victoria ${homeName} — mercado 1X2` : "Más de 1.5 goles";
  const pick = sanitizePick(aiData?.pick || fallbackPick, tier, fixture);
  const seoTitle =
    aiData?.seo_title ||
    `Pronóstico ${fixture.homeTeam} vs ${fixture.awayTeam} hoy | ${fixture.league} | DeportivosPro`;
  const seoDescription =
    aiData?.seo_description ||
    `Análisis de ${fixture.homeTeam} vs ${fixture.awayTeam} en ${fixture.league}. Pronóstico y datos clave del partido de hoy.`;
  return {
    sport: fixture.sport,
    league: fixture.league,
    homeTeam: { name: fixture.homeTeam, logo: "" },
    awayTeam: { name: fixture.awayTeam, logo: "" },
    prediction: pick,
    confidence,
    probability: clamp(confidence + (tier === "vip" ? 3 : 5), 50, 97),
    odds: estimateOddsFromConfidence(confidence),
    date: fixture.match_date,
    hours: fixture.match_hour,
    source: "ai-engine",
    analysis: aiData?.analysis || `${tier.toUpperCase()}: predicción generada por motor propio IA + reglas.`,
    seo_title: seoTitle,
    seo_description: seoDescription,
    slug: toSlug(`${fixture.match_date}-${fixture.homeTeam}-vs-${fixture.awayTeam}-${tier}-${index + 1}`),
  };
}

function parseModelJson(content) {
  const trimmed = String(content || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("JSON inválido en respuesta IA");
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

async function callChatModel(prompt, systemOverride) {
  const url = process.env.FACTORY_AI_BASE_URL || "https://api.deepseek.com";
  const apiKey = process.env.FACTORY_AI_API_KEY;
  const model = process.env.FACTORY_AI_MODEL || "deepseek-chat";
  if (!apiKey) {
    throw new Error("FACTORY_AI_API_KEY no configurada");
  }
  const system =
    typeof systemOverride === "string" && systemOverride.trim()
      ? systemOverride.trim()
      : "Responde solo JSON válido.";
  const { data } = await axios.post(
    `${url}/v1/chat/completions`,
    {
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    {
      timeout: Number.parseInt(process.env.FACTORY_AI_TIMEOUT_MS || "12000", 10),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Respuesta IA vacía");
  return parseModelJson(content);
}

function isAiLiveEnabled() {
  if (!isAiEnabled()) return false;
  return String(process.env.FACTORY_AI_LIVE_ENABLED || "true").toLowerCase() !== "false";
}

function buildLivePrompt(match, heuristic) {
  return [
    "Eres trader deportivo EN VIVO. Responde SOLO JSON válido sin markdown.",
    "Datos del encuentro en curso:",
    JSON.stringify({
      deporte: match.sport || "football",
      liga: match.league || "",
      local: match.homeTeam,
      visitante: match.awayTeam,
      marcador: `${match.homeGoals ?? 0}-${match.awayGoals ?? 0}`,
      minuto_aprox: match.minute ?? 0,
      estado_fuente: match.status_short || match.status || "",
    }),
    "",
    `Sugerencia base del motor (ajústala o sustitúyela si ves mejor valor): "${heuristic.prediction}" (~${heuristic.confidence}% confianza).`,
    "",
    "Devuelve UN pick accionable en vivo con lectura del ritmo y del marcador.",
    "NO uses Draw No Bet ni empate anulado. Prefiere: siguiente gol / over goles totales o resto del partido / ambos marcan (resto o total) / córners o tiros si encaja.",
    "",
    'Formato: { "pick": "texto corto", "confidence": 55-88, "analysis": "2-4 frases en español", "odds_hint": 1.5, "invalid_context": false }',
    "Si el contexto es incoherente (ej. minuto 0 sin partido real) pon invalid_context true y pick vacío.",
  ].join("\n");
}

/**
 * Refina señal live con DeepSeek usando marcador, minuto y heurística local.
 */
async function generateLiveInsightFromMatch(match, heuristicSuggestion) {
  if (!isAiLiveEnabled() || !heuristicSuggestion) {
    return null;
  }
  try {
    const raw = await callChatModel(buildLivePrompt(match, heuristicSuggestion));
    const invalid = Boolean(raw?.invalid_context);
    const pickRaw = String(raw?.pick || "").trim();
    if (invalid || !pickRaw) {
      return null;
    }
    const fixtureLike = { homeTeam: match.homeTeam };
    const pick = sanitizePick(pickRaw, "vip", fixtureLike);
    const confidence = clamp(
      Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : heuristicSuggestion.confidence,
      52,
      90
    );
    const odds =
      Number.isFinite(Number(raw.odds_hint)) && Number(raw.odds_hint) > 1
        ? Number(Number(raw.odds_hint).toFixed(2))
        : heuristicSuggestion.odds;
    const analysis =
      String(raw.analysis || "").trim() ||
      `Lectura en vivo ${match.homeTeam} vs ${match.awayTeam}: ${pick}.`;
    return {
      pick,
      confidence,
      odds,
      analysis,
      invalid_context: false,
    };
  } catch (error) {
    logger.warn(`IA live falló (${match.homeTeam} vs ${match.awayTeam}): ${error.message}`);
    return null;
  }
}

async function generateAiPredictionsFromFixtures(fixtures = []) {
  if (!isAiEnabled()) return { free: [], vip: [] };
  const limit = Number.parseInt(process.env.FACTORY_AI_MATCH_LIMIT || "6", 10);
  const selected = fixtures.slice(0, Math.max(1, limit));
  const marketsPerMatch = Number.parseInt(process.env.FACTORY_MARKETS_PER_MATCH || "1", 10);
  const gapMs = Number.parseInt(process.env.FACTORY_AI_DELAY_MS || "2500", 10);
  const free = [];
  const vip = [];
  for (let i = 0; i < selected.length; i += 1) {
    const fixture = selected[i];
    try {
      const aiJson = await callChatModel(buildPrompt(fixture));
      const freeRows = Array.isArray(aiJson?.free) ? aiJson.free : aiJson?.free ? [aiJson.free] : [];
      const vipRows = Array.isArray(aiJson?.vip) ? aiJson.vip : aiJson?.vip ? [aiJson.vip] : [];
      freeRows.slice(0, Math.max(1, marketsPerMatch)).forEach((row, idx) => {
        free.push(toPredictionRecord(fixture, "free", row, idx));
      });
      vipRows.slice(0, Math.max(1, marketsPerMatch)).forEach((row, idx) => {
        vip.push(toPredictionRecord(fixture, "vip", row, idx));
      });
    } catch (error) {
      logger.warn(`IA falló para ${fixture.homeTeam} vs ${fixture.awayTeam}: ${error.message}`);
    }
    if (gapMs > 0 && i < selected.length - 1) {
      await delay(gapMs);
    }
  }

  function aiPickDedupeKey(pick) {
    const home = pick.homeTeam?.name || "";
    const away = pick.awayTeam?.name || "";
    const date = pick.date || "";
    return `${home.toLowerCase()}|${away.toLowerCase()}|${date}|${normalizePickLabel(pick.prediction || "")}`;
  }

  return {
    free: mergeDedupeByKey([free], aiPickDedupeKey),
    vip: mergeDedupeByKey([vip], aiPickDedupeKey),
  };
}

module.exports = {
  callChatModel,
  generateAiPredictionsFromFixtures,
  generateLiveInsightFromMatch,
  isAiEnabled,
  isAiLiveEnabled,
};
