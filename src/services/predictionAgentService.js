/**
 * Agent-style multi-step pick factory:
 * research (local) → analysis+pick (Minimax) → normalize for publish.
 * No human approval gate — pipeline publishes straight to MatuDB plant tables.
 */
const logger = require("../utils/logger");
const { clamp } = require("../utils/helpers");
const { estimateOddsFromConfidence } = require("./oddsService");
const { buildPredictionSeo } = require("../utils/predictionSeo");
const { scrubPlayStoreText, playStoreSystemGuard } = require("../utils/playStoreSafe");
const { mergeDedupeByKey, normalizePickLabel } = require("../utils/predictionDedupe");
const { resolveTeamLogoUrl } = require("./futboolLogoService");

const SPORT_MARKET_HINTS = {
  football:
    "1X2, hándicap asiático, over/under goles, ambos marcan, córners. NO Draw No Bet / DNB.",
  basketball: "spread/handicap, totales de puntos, 1Q/1H totals, ganador del partido.",
  tennis: "ganador del partido, sets, total games, handicap games.",
  baseball: "moneyline, run line, totales de carreras, F5.",
  hockey: "ganador (incl. OT si aplica), puck line, totales de goles.",
  mma: "ganador, método (KO/decisión), over/under rounds.",
  esports: "ganador del mapa/partido, totales de mapas, handicap mapas.",
};

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
    /\bdnb\b/.test(s)
  );
}

/** Paso 1 — research local (sin API): brief estructurado del fixture. */
function buildResearchBrief(fixture) {
  const sport = String(fixture.sport || "football").toLowerCase();
  return {
    sport,
    league: fixture.league || "League",
    home: fixture.homeTeam || "Local",
    away: fixture.awayTeam || "Visitante",
    match_date: fixture.match_date,
    match_hour: fixture.match_hour,
    status: fixture.status || "pre",
    event_id: fixture.eventId || null,
    market_hints: SPORT_MARKET_HINTS[sport] || SPORT_MARKET_HINTS.football,
    notes: [
      "Prioriza valor informativo y coherencia táctica/estilo.",
      "Si faltan datos de forma/H2H, sé conservador en confidence.",
      "Free = tip accesible; VIP = tip con más edge y análisis más profundo.",
    ],
  };
}

function buildAgentPrompt(brief, marketsPerMatch) {
  return [
    "Pipeline MatuPicks (multi-step en una sola respuesta JSON):",
    "1) research_summary: 1-2 frases con contexto liga/equipos/horario.",
    "2) analysis: 3-5 frases (forma ilustrativa, estilo, motivaciones, riesgos).",
    `3) free: ${marketsPerMatch} tip(s) FREE; vip: ${marketsPerMatch} tip(s) VIP.`,
    `Mercados sugeridos (${brief.sport}): ${brief.market_hints}`,
    "Confidence: free 58-78, vip 72-92. Sin Draw No Bet.",
    "Campos pick = tip corto en español; analysis por pick opcional.",
    "",
    `Partido: ${brief.home} vs ${brief.away}`,
    `Liga: ${brief.league}`,
    `Deporte: ${brief.sport}`,
    `Fecha: ${brief.match_date} ${brief.match_hour || ""}`.trim(),
    `Notas: ${brief.notes.join(" ")}`,
    "",
    'Formato: { "research_summary": "...", "analysis": "...",',
    '  "free": [{ "pick": "...", "confidence": 0-100, "analysis": "..." }],',
    '  "vip": [{ "pick": "...", "confidence": 0-100, "analysis": "..." }] }',
  ].join("\n");
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

function toPredictionRecord(fixture, tier, aiData, index, sharedAnalysis) {
  const confidenceBase = tier === "vip" ? 72 : 62;
  const confidence = clamp(
    Number.isFinite(aiData?.confidence) ? Number(aiData.confidence) : confidenceBase,
    tier === "vip" ? 65 : 55,
    tier === "vip" ? 93 : 82
  );
  const pick = sanitizePick(aiData?.pick || "", tier, fixture);
  const analysis = scrubPlayStoreText(
    aiData?.analysis ||
      sharedAnalysis ||
      `${tier.toUpperCase()}: tip informativo generado por agente MatuPicks.`
  );
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
    source: "matupicks-agent",
    analysis,
    rationale_short: analysis.slice(0, 180),
    seo_title: scrubPlayStoreText(seo.seo_title),
    seo_description: scrubPlayStoreText(seo.seo_description),
    slug: toSlug(
      `${fixture.match_date}-${fixture.homeTeam}-vs-${fixture.awayTeam}-${tier}-${index + 1}`
    ),
  };
}

/**
 * Ejecuta research → IA (analysis+picks) para una lista de fixtures.
 * @param {Function} callChatModel — inyectado desde aiForecastService (evita ciclo require).
 */
async function runAgentPickPipeline(fixtures = [], callChatModel, opts = {}) {
  const marketsPerMatch = Number.parseInt(process.env.FACTORY_MARKETS_PER_MATCH || "1", 10);
  const gapMs = Number.parseInt(process.env.FACTORY_AI_DELAY_MS || "2500", 10);
  const envLimit = Number.parseInt(process.env.FACTORY_AI_MATCH_LIMIT || "20", 10);
  const override = opts.matchLimit;
  const limit =
    typeof override === "number" && Number.isFinite(override)
      ? Math.max(1, Math.floor(override))
      : Math.max(1, envLimit);
  const selected = fixtures.slice(0, limit);
  const free = [];
  const vip = [];
  const system = playStoreSystemGuard();

  for (let i = 0; i < selected.length; i += 1) {
    const fixture = selected[i];
    const brief = buildResearchBrief(fixture);
    try {
      const aiJson = await callChatModel(buildAgentPrompt(brief, marketsPerMatch), system);
      const shared = scrubPlayStoreText(
        [aiJson?.research_summary, aiJson?.analysis].filter(Boolean).join(" ")
      );
      const freeRows = Array.isArray(aiJson?.free)
        ? aiJson.free
        : aiJson?.free
          ? [aiJson.free]
          : [];
      const vipRows = Array.isArray(aiJson?.vip)
        ? aiJson.vip
        : aiJson?.vip
          ? [aiJson.vip]
          : [];
      freeRows.slice(0, Math.max(1, marketsPerMatch)).forEach((row, idx) => {
        free.push(toPredictionRecord(fixture, "free", row, idx, shared));
      });
      vipRows.slice(0, Math.max(1, marketsPerMatch)).forEach((row, idx) => {
        vip.push(toPredictionRecord(fixture, "vip", row, idx, shared));
      });
      logger.info(
        `[agent] tip listo ${brief.sport}: ${brief.home} vs ${brief.away}`
      );
    } catch (error) {
      logger.warn(
        `[agent] falló ${fixture.homeTeam} vs ${fixture.awayTeam}: ${error.message}`
      );
    }
    if (gapMs > 0 && i < selected.length - 1) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  function key(pick) {
    const home = pick.homeTeam?.name || "";
    const away = pick.awayTeam?.name || "";
    const date = pick.date || "";
    return `${home.toLowerCase()}|${away.toLowerCase()}|${date}|${normalizePickLabel(pick.prediction || "")}`;
  }

  return {
    free: mergeDedupeByKey([free], key),
    vip: mergeDedupeByKey([vip], key),
  };
}

function isAgentModeEnabled() {
  return String(process.env.FACTORY_AI_AGENT_MODE || "true").toLowerCase() !== "false";
}

module.exports = {
  buildResearchBrief,
  runAgentPickPipeline,
  isAgentModeEnabled,
  SPORT_MARKET_HINTS,
};
