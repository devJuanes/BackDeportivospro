const axios = require("axios");
const { estimateOddsFromConfidence } = require("./oddsService");
const { clamp } = require("../utils/helpers");
const logger = require("../utils/logger");
const { mergeDedupeByKey, normalizePickLabel } = require("../utils/predictionDedupe");
const { buildPredictionSeo } = require("../utils/predictionSeo");
const { scrubPlayStoreText, playStoreSystemGuard } = require("../utils/playStoreSafe");
const {
  runAgentPickPipeline,
  isAgentModeEnabled,
  SPORT_MARKET_HINTS,
} = require("./predictionAgentService");
const { resolveTeamLogoUrl } = require("./futboolLogoService");
const {
  filterFixturesForTips,
  passesQualityGate,
} = require("../utils/fixtureQuality");

function isAiEnabled() {
  if (process.env.FACTORY_AI_ENABLED !== "true") return false;
  const cfg = getAiProviderConfig();
  return Boolean(cfg.apiKey);
}

function getAiProviderConfig() {
  const provider = String(process.env.FACTORY_AI_PROVIDER || "").trim().toLowerCase();
  const minimaxKey = String(process.env.MINIMAX_API_KEY || "").trim();
  const factoryKey = String(process.env.FACTORY_AI_API_KEY || "").trim();
  const useMinimax =
    provider === "minimax" ||
    (Boolean(minimaxKey) && provider !== "deepseek");

  if (useMinimax) {
    return {
      provider: "minimax",
      url: (process.env.FACTORY_AI_BASE_URL || "https://api.minimax.io/v1").replace(/\/$/, ""),
      apiKey: minimaxKey || factoryKey,
      model:
        process.env.MINIMAX_MODEL ||
        process.env.FACTORY_AI_MODEL ||
        "MiniMax-M2.5",
    };
  }

  return {
    provider: "openai-compatible",
    url: (process.env.FACTORY_AI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    apiKey: factoryKey,
    model: process.env.FACTORY_AI_MODEL || "deepseek-chat",
  };
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
  const raw = scrubPlayStoreText(pick);
  if (!raw || looksLikeDrawNoBet(raw)) {
    const home = fixture?.homeTeam || "local";
    const sport = String(fixture?.sport || "football").toLowerCase();
    if (sport === "basketball") {
      return tier === "vip" ? "Local -2.5 handicap" : "Más de 159.5 puntos";
    }
    if (sport === "tennis") {
      return tier === "vip" ? "Ganador 2-0 sets" : "Más de 20.5 games";
    }
    if (sport === "hockey") {
      return tier === "vip" ? "Más de 5.5 goles" : "Más de 4.5 goles";
    }
    return tier === "vip"
      ? `Victoria ${home} — mercado 1X2`
      : "Más de 1.5 goles";
  }
  return raw;
}

function buildPrompt(fixture) {
  const marketsPerMatch = Number.parseInt(process.env.FACTORY_MARKETS_PER_MATCH || "1", 10);
  const sport = String(fixture.sport || "football").toLowerCase();
  const marketHints = SPORT_MARKET_HINTS[sport] || SPORT_MARKET_HINTS.football;
  return [
    "Eres analista senior de MatuPicks. Responde SOLO JSON válido sin markdown.",
    `Genera hasta ${marketsPerMatch} tip(s) FREE y hasta ${marketsPerMatch} VIP (calidad > cantidad).`,
    "Si no hay edge claro, free/vip = []. No inventes tips genéricos.",
    "Cada tip con análisis concreto (estilo, ritmo, motivación, riesgos).",
    `Mercados: ${marketHints}`,
    "NO uses Draw No Bet ni DNB. Lenguaje Play Store safe (tips/consejos; nunca CTAs de apuestas).",
    "Confidence realista (free 62-78, vip 74-90). VIP distinto y con más edge que FREE.",
    "",
    `Partido: ${fixture.homeTeam} vs ${fixture.awayTeam}`,
    `Liga: ${fixture.league}`,
    `Deporte: ${fixture.sport}`,
    `Fecha: ${fixture.match_date}`,
    `Hora: ${fixture.match_hour}`,
    "",
    'Formato: { "free": [{ "pick": "...", "confidence": 0-100, "analysis": "3-5 frases" }],',
    '  "vip": [{ "pick": "...", "confidence": 0-100, "analysis": "3-5 frases" }] }',
  ].join("\n");
}

function toPredictionRecord(fixture, tier, aiData, index = 0) {
  const confidenceBase = tier === "vip" ? 74 : 64;
  const confidence = clamp(
    Number.isFinite(aiData?.confidence) ? Number(aiData.confidence) : confidenceBase,
    tier === "vip" ? 70 : 60,
    tier === "vip" ? 93 : 82
  );
  const homeName = fixture?.homeTeam || "local";
  const fallbackPick =
    tier === "vip" ? `Victoria ${homeName} — mercado 1X2` : "Más de 1.5 goles";
  const pick = sanitizePick(aiData?.pick || fallbackPick, tier, fixture);
  const seo = buildPredictionSeo({
    seo_title: aiData?.seo_title,
    seo_description: aiData?.seo_description,
    homeTeam: { name: fixture.homeTeam },
    awayTeam: { name: fixture.awayTeam },
    league: fixture.league,
    prediction: pick,
    date: fixture.match_date,
    tier,
  });
  const analysis = scrubPlayStoreText(
    aiData?.analysis ||
      `${tier.toUpperCase()}: tip informativo generado por motor IA MatuPicks.`
  );
  return {
    sport: fixture.sport,
    league: fixture.league,
    homeTeam: {
      name: fixture.homeTeam,
      logo: resolveTeamLogoUrl(fixture.homeTeam, fixture.league),
    },
    awayTeam: {
      name: fixture.awayTeam,
      logo: resolveTeamLogoUrl(fixture.awayTeam, fixture.league),
    },
    prediction: pick,
    confidence,
    probability: clamp(confidence + (tier === "vip" ? 3 : 5), 50, 97),
    odds: estimateOddsFromConfidence(confidence),
    date: fixture.match_date,
    hours: fixture.match_hour,
    source: `${getAiProviderConfig().provider}-ai`,
    analysis,
    seo_title: scrubPlayStoreText(seo.seo_title),
    seo_description: scrubPlayStoreText(seo.seo_description),
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

/**
 * @param {string} prompt
 * @param {string} [systemOverride]
 * @param {{ timeoutMs?: number }} [opts]  timeout por petición (p. ej. previas largas vía `BLOG_AI_TIMEOUT_MS`).
 */
async function callChatModel(prompt, systemOverride, opts = {}) {
  const cfg = getAiProviderConfig();
  const apiKey = cfg.apiKey;
  const model = cfg.model;
  if (!apiKey) {
    throw new Error("Configura MINIMAX_API_KEY o FACTORY_AI_API_KEY");
  }
  const system =
    typeof systemOverride === "string" && systemOverride.trim()
      ? systemOverride.trim()
      : playStoreSystemGuard();
  const defaultMs = Number.parseInt(process.env.FACTORY_AI_TIMEOUT_MS || "12000", 10);
  const timeout =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1000, opts.timeoutMs)
      : defaultMs;

  const body = {
    model,
    temperature: cfg.provider === "minimax" ? 0.3 : 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  };

  const { data } = await axios.post(`${cfg.url}/chat/completions`, body, {
    timeout,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Respuesta IA vacía");
  return parseModelJson(content);
}

function isAiLiveEnabled() {
  if (!isAiEnabled()) return false;
  return String(process.env.FACTORY_AI_LIVE_ENABLED || "true").toLowerCase() !== "false";
}

function buildLivePrompt(match, heuristic) {
  const hg = Number(match.homeGoals) || 0;
  const ag = Number(match.awayGoals) || 0;
  const minute = Number(match.minute) || 0;
  const total = hg + ag;
  const trailing =
    hg === ag ? "empate" : hg > ag ? `${match.awayTeam} va perdiendo` : `${match.homeTeam} va perdiendo`;

  return [
    "Eres estratega EN VIVO de MatuPicks (servicio premium). Responde SOLO JSON válido sin markdown.",
    "Objetivo: tip de ALTA CALIDAD para usuarios que pueden apostar — NO quemar su dinero con tips flojos.",
    "Lenguaje: tip/consejo informativo (Play Store safe). Sin CTAs de casas de apuestas.",
    "",
    "CONTEXTO DEL PARTIDO:",
    JSON.stringify({
      deporte: match.sport || "football",
      liga: match.league || "",
      local: match.homeTeam,
      visitante: match.awayTeam,
      marcador: `${hg}-${ag}`,
      minuto_aprox: minute,
      goles_totales: total,
      situacion: trailing,
      estado_fuente: match.status_short || match.status || "",
    }),
    "",
    `Sugerencia heurística (solo punto de partida; PUEDES descartarla): "${heuristic.prediction}" (~${heuristic.confidence}%).`,
    "",
    "ESTRATEGIA OBLIGATORIA (razona antes de elegir el tip):",
    "1) Ritmo: ¿el marcador y el minuto justifican más goles, o partido cerrado?",
    "2) Favorito vs underdog: si un grande/favorito va empatando o perdiendo, valora remonte o next goal — SOLO si el ritmo lo respalda.",
    "3) NO digas siempre 'va a haber otro gol' solo porque van 1-0 o 2-0 al 70'. Eso es basura.",
    "4) Prefiere mercados con lógica: next team to score, BTTS, over/under RESTANTE de goles, corners/cards solo si el contexto es claro.",
    "5) Si NO hay edge claro → invalid_context true (mejor silencio que tip malo).",
    "6) confidence conservadora: 58-78 tipico; >82 solo con evidencia fuerte del marcador+minuto.",
    "",
    'Formato: { "pick": "texto corto", "confidence": 55-85, "analysis": "2-4 frases: POR QUÉ (estrategia, no solo el marcador)", "odds_hint": 1.5, "invalid_context": false, "strategy_tag": "remonte|ritmo_abierto|favorito_presion|partido_cerrado|corners|otro" }',
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
    const analysis = scrubPlayStoreText(
      String(raw.analysis || "").trim() ||
        `Lectura en vivo ${match.homeTeam} vs ${match.awayTeam}: ${pick}.`
    );
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

async function generateAiPredictionsFromFixtures(fixtures = [], opts = {}) {
  if (!isAiEnabled()) return { free: [], vip: [] };

  /** Modo agente (default): research local → analysis+pick Minimax → listo para planta. */
  if (isAgentModeEnabled()) {
    return runAgentPickPipeline(fixtures, callChatModel, opts);
  }

  const envLimit = Number.parseInt(process.env.FACTORY_AI_MATCH_LIMIT || "20", 10);
  const override = opts.matchLimit;
  const limit =
    typeof override === "number" && Number.isFinite(override)
      ? Math.max(1, Math.floor(override))
      : Math.max(1, envLimit);
  const selected = filterFixturesForTips(fixtures, { allowLive: false }).slice(0, limit);
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
        const rec = toPredictionRecord(fixture, "free", row, idx);
        if (passesQualityGate(rec, "free")) free.push(rec);
      });
      vipRows.slice(0, Math.max(1, marketsPerMatch)).forEach((row, idx) => {
        const rec = toPredictionRecord(fixture, "vip", row, idx);
        if (passesQualityGate(rec, "vip")) vip.push(rec);
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
  getAiProviderConfig,
  isAgentModeEnabled,
};
