const { estimateOddsFromConfidence } = require("./oddsService");
const { clamp } = require("../utils/helpers");

const MARKET_TEMPLATES = {
  football: {
    free: [
      { market: "Más de 1.5 goles", baseConfidence: 62, rationale: "Tendencia conservadora para jornada activa." },
      { market: "Ambos equipos marcan: SI", baseConfidence: 60, rationale: "Cruce con perfiles ofensivos equilibrados." },
      { market: "Doble oportunidad 1X", baseConfidence: 64, rationale: "Cobertura de riesgo sobre localía." },
      { market: "Menos de 3.5 goles", baseConfidence: 61, rationale: "Perfil de partido más táctico." },
      { market: "Más de 2.5 goles", baseConfidence: 58, rationale: "Partido con potencial de intercambio." },
    ],
    vip: [
      { market: "Hándicap asiático local -0.25", baseConfidence: 73, rationale: "Ventaja local con gestión de empate parcial." },
      { market: "Ambos equipos marcan + Más de 2.5", baseConfidence: 71, rationale: "Escenario de alta producción ofensiva." },
      { market: "Total córners: Más de 8.5", baseConfidence: 69, rationale: "Ritmo alto y amplitud por bandas." },
      { market: "Tarjetas: Más de 3.5", baseConfidence: 70, rationale: "Contexto competitivo y fricción esperada." },
      { market: "Draw No Bet local", baseConfidence: 74, rationale: "Protección de stake con sesgo local." },
    ],
  },
  basketball: {
    free: [
      { market: "Más de 159.5 puntos", baseConfidence: 61, rationale: "Ritmo medio-alto esperado." },
      { market: "Local +4.5 handicap", baseConfidence: 60, rationale: "Cobertura contra cierre apretado." },
      { market: "Visitante +5.5 handicap", baseConfidence: 59, rationale: "Valor por spread amplio." },
    ],
    vip: [
      { market: "Más de 169.5 puntos", baseConfidence: 71, rationale: "Proyección ofensiva superior a media." },
      { market: "1Q más de 41.5 puntos", baseConfidence: 69, rationale: "Inicio con pace alto." },
      { market: "Local -2.5 handicap", baseConfidence: 72, rationale: "Cierre favorable por eficiencia local." },
    ],
  },
  baseball: {
    free: [
      { market: "Más de 6.5 carreras", baseConfidence: 60, rationale: "Bullpen con riesgo de concesión." },
      { market: "Menos de 9.5 carreras", baseConfidence: 59, rationale: "Duelo con control de pitcheo." },
      { market: "Run line +1.5 visitante", baseConfidence: 61, rationale: "Juego proyectado cerrado." },
    ],
    vip: [
      { market: "Run line -1.5 local", baseConfidence: 72, rationale: "Ventaja clara en abridor y lineup." },
      { market: "Más de 7.5 carreras", baseConfidence: 70, rationale: "Contexto favorable al bateo." },
      { market: "Primeras 5 entradas: local gana", baseConfidence: 71, rationale: "Edge temprano del abridor local." },
    ],
  },
  tennis: {
    free: [
      { market: "Más de 20.5 games", baseConfidence: 60, rationale: "Emparejamiento equilibrado de servicio." },
      { market: "Ganador del partido: favorito", baseConfidence: 62, rationale: "Jerarquía y forma reciente." },
    ],
    vip: [
      { market: "Ganador 2-0 sets", baseConfidence: 71, rationale: "Superioridad técnica marcada." },
      { market: "Hándicap games -2.5 favorito", baseConfidence: 70, rationale: "Dominio sostenido por consistencia." },
    ],
  },
  mma: {
    free: [
      { market: "Más de 1.5 rounds", baseConfidence: 59, rationale: "Combate con perfil táctico inicial." },
      { market: "La pelea llega a decisión: NO", baseConfidence: 60, rationale: "Estilo de finalización elevado." },
    ],
    vip: [
      { market: "Método de victoria: KO/TKO", baseConfidence: 71, rationale: "Matchup favorable de striking." },
      { market: "Victoria del favorito", baseConfidence: 73, rationale: "Ventaja integral en estadísticas clave." },
    ],
  },
  hockey: {
    free: [
      { market: "Más de 4.5 goles", baseConfidence: 60, rationale: "Ritmo y volumen de tiros consistentes." },
      { market: "Doble oportunidad local", baseConfidence: 61, rationale: "Factor local en matchups cerrados." },
    ],
    vip: [
      { market: "Más de 5.5 goles", baseConfidence: 70, rationale: "Alta varianza ofensiva proyectada." },
      { market: "Hándicap local -1.5", baseConfidence: 72, rationale: "Ventaja diferencial en transición." },
    ],
  },
};

function hashString(value = "") {
  let hash = 0;
  const str = String(value);
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickTemplateByFixture(fixture, tier) {
  const sportTemplates = MARKET_TEMPLATES[fixture.sport] || MARKET_TEMPLATES.football;
  const pool = sportTemplates[tier] || sportTemplates.free;
  const seed = `${fixture.eventId || ""}|${fixture.homeTeam}|${fixture.awayTeam}|${tier}`;
  const index = hashString(seed) % pool.length;
  return pool[index];
}

function parseTeams(matchText = "") {
  const normalized = String(matchText).replace(" vs ", " - ");
  const [home, away] = normalized.split(" - ").map((s) => s?.trim());
  return {
    homeTeam: { name: home || "Equipo local", logo: "" },
    awayTeam: { name: away || "Equipo visitante", logo: "" },
  };
}

function parseConfidence(probability = "") {
  const numeric = Number.parseInt(String(probability).replace(/[^\d]/g, ""), 10);
  if (Number.isNaN(numeric)) {
    return 60;
  }
  return clamp(numeric, 45, 90);
}

function toPredictionRecord(scrapedRow, sport = "football") {
  const teams = parseTeams(scrapedRow.match);
  const confidence = parseConfidence(scrapedRow.probability);
  const date = scrapedRow.match_date || new Date().toISOString().slice(0, 10);
  const hours = scrapedRow.match_hour || "00:00";

  return {
    sport,
    league: "Auto League",
    ...teams,
    prediction: scrapedRow.prediction || "Doble oportunidad 1X",
    confidence,
    odds: estimateOddsFromConfidence(confidence),
    score_prediction: scrapedRow.score || "1-0",
    date,
    hours,
    state: "pendiente",
    source: scrapedRow.source,
    source_url: scrapedRow.source_url,
  };
}

function generatePredictions(scrapedRows = [], sport = "football") {
  return scrapedRows.map((row) => toPredictionRecord(row, sport));
}

function normalizePredictionLabel(label = "") {
  return String(label).trim().toLowerCase();
}

function ensureVipPredictionDiff(basePrediction = "") {
  const normalized = normalizePredictionLabel(basePrediction);
  if (
    normalized.includes("gana") ||
    normalized.includes("1x2") ||
    normalized.includes("victoria")
  ) {
    return "Ambos equipos marcan: SI";
  }
  if (normalized.includes("over 2.5")) {
    return "Over 1.5 goles";
  }
  if (normalized.includes("under")) {
    return "Menos de 3.5 goles";
  }
  return "Doble oportunidad X2";
}

function buildRationale(row, tier = "free") {
  const source = row.source || "multi-fuente";
  if (tier === "vip") {
    return `VIP: consenso + contexto de riesgo (${source}), mayor filtro de valor y disciplina de banca.`;
  }
  return `FREE: pick por consenso estadístico (${source}) para jornada actual.`;
}

function splitFreeAndVipPredictions(
  scrapedRows = [],
  sport = "football",
  limits = { free: 10, vip: 10 }
) {
  const base = generatePredictions(scrapedRows, sport);
  const seenMatches = new Set();
  const free = [];
  const vip = [];

  for (const row of base) {
    const matchKey = `${row.homeTeam?.name || "home"}::${row.awayTeam?.name || "away"}::${row.date}`;
    if (free.length < limits.free && !seenMatches.has(matchKey)) {
      free.push({
        ...row,
        confidence: clamp(row.confidence, 55, 78),
        rationale_short: buildRationale(row, "free"),
      });
      seenMatches.add(matchKey);
      continue;
    }

    if (vip.length < limits.vip) {
      vip.push({
        ...row,
        prediction: ensureVipPredictionDiff(row.prediction),
        confidence: clamp(row.confidence + 8, 65, 92),
        odds: estimateOddsFromConfidence(clamp(row.confidence + 8, 65, 92)),
        rationale_short: buildRationale(row, "vip"),
      });
    }

    if (free.length >= limits.free && vip.length >= limits.vip) {
      break;
    }
  }

  return { free, vip };
}

function buildTierPredictionsFromScraped(
  scrapedRows = [],
  sport = "football",
  tier = "free",
  limit = 10
) {
  const base = generatePredictions(scrapedRows, sport);
  const out = [];
  const seen = new Set();

  for (const row of base) {
    const key = `${row.homeTeam?.name || "home"}::${row.awayTeam?.name || "away"}::${row.date}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (tier === "vip") {
      out.push({
        ...row,
        prediction: ensureVipPredictionDiff(row.prediction),
        confidence: clamp(row.confidence + 8, 66, 92),
        odds: estimateOddsFromConfidence(clamp(row.confidence + 8, 66, 92)),
        rationale_short: buildRationale(row, "vip"),
      });
    } else {
      out.push({
        ...row,
        confidence: clamp(row.confidence, 55, 78),
        rationale_short: buildRationale(row, "free"),
      });
    }

    if (out.length >= limit) {
      break;
    }
  }

  return out;
}

function buildPredictionFromFixture(fixture, tier = "free") {
  const market = pickTemplateByFixture(fixture, tier);
  const bias = (fixture.homeGoals || 0) - (fixture.awayGoals || 0);
  const variation = (hashString(fixture.eventId || `${fixture.homeTeam}-${fixture.awayTeam}`) % 7) - 3;
  const confidence = clamp(
    market.baseConfidence + bias * 2 + variation,
    tier === "vip" ? 67 : 54,
    tier === "vip" ? 91 : 79
  );
  const oddsShift = tier === "vip" ? -0.06 : 0.08;
  const odds = clamp(
    Number((estimateOddsFromConfidence(confidence) + oddsShift).toFixed(2)),
    1.2,
    4.5
  );

  return {
    sport: fixture.sport,
    league: fixture.league,
    homeTeam: { name: fixture.homeTeam, logo: "" },
    awayTeam: { name: fixture.awayTeam, logo: "" },
    prediction: market.market,
    confidence,
    odds,
    score_prediction: "N/A",
    date: fixture.match_date,
    hours: fixture.match_hour,
    state: "pendiente",
    source: "ESPN",
    rationale_short:
      tier === "vip"
        ? `VIP: ${market.rationale}`
        : `FREE: ${market.rationale}`,
  };
}

function buildPredictionsFromFixtures(fixtures = [], limits = { free: 10, vip: 10 }) {
  const free = [];
  const vip = [];
  const seen = new Set();

  for (const fixture of fixtures) {
    const key = `${fixture.homeTeam}|${fixture.awayTeam}|${fixture.match_date}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (free.length < limits.free) {
      free.push(buildPredictionFromFixture(fixture, "free"));
      continue;
    }
    if (vip.length < limits.vip) {
      vip.push(buildPredictionFromFixture(fixture, "vip"));
    }
    if (free.length >= limits.free && vip.length >= limits.vip) {
      break;
    }
  }

  return { free, vip };
}

function generateLiveSuggestion(match) {
  const total = (match.homeGoals || 0) + (match.awayGoals || 0);
  const diff = Math.abs((match.homeGoals || 0) - (match.awayGoals || 0));
  const minute = match.minute || 0;

  // Filtro de calidad: si no hay contexto suficiente, no emitir señal.
  if (minute <= 0) {
    return null;
  }

  if (match.sport === "football" && minute >= 70 && total === 0) {
    return {
      sport: match.sport || "football",
      league: match.league || "Live League",
      home_team_name: match.homeTeam,
      away_team_name: match.awayTeam,
      minute,
      prediction: "Over 0.5 goles",
      confidence: 74,
      odds: 1.38,
    };
  }

  if (match.sport === "football" && minute >= 55 && total === 1 && diff <= 1) {
    return {
      sport: match.sport || "football",
      league: match.league || "Live League",
      home_team_name: match.homeTeam,
      away_team_name: match.awayTeam,
      minute,
      prediction: "Over 1.5 goles",
      confidence: 68,
      odds: 1.62,
    };
  }

  if (match.sport === "football" && minute >= 35 && minute <= 75 && total >= 2 && diff <= 2) {
    return {
      sport: match.sport || "football",
      league: match.league || "Live League",
      home_team_name: match.homeTeam,
      away_team_name: match.awayTeam,
      minute,
      prediction: "Over 2.5 goles",
      confidence: 67,
      odds: 1.66,
    };
  }

  if (match.sport === "basketball" && minute >= 24 && total >= 120 && diff <= 18) {
    return {
      sport: match.sport,
      league: match.league || "Live League",
      home_team_name: match.homeTeam,
      away_team_name: match.awayTeam,
      minute,
      prediction: "Más de 169.5 puntos en vivo",
      confidence: 69,
      odds: 1.64,
    };
  }

  return null;
}

module.exports = {
  generatePredictions,
  splitFreeAndVipPredictions,
  buildTierPredictionsFromScraped,
  buildPredictionsFromFixtures,
  generateLiveSuggestion,
};
