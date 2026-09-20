const { estimateOddsFromConfidence } = require("./oddsService");
const { clamp } = require("../utils/helpers");
const { resolveTeamLogoUrl } = require("./futboolLogoService");

const MARKET_TEMPLATES = {
  football: {
    free: [
      { market: "Más de 1.5 goles", baseConfidence: 64, rationale: "Tendencia conservadora para jornada activa." },
      { market: "Ambos equipos marcan: SI", baseConfidence: 62, rationale: "Cruce con perfiles ofensivos equilibrados." },
      { market: "Doble oportunidad 1X", baseConfidence: 65, rationale: "Cobertura de riesgo sobre localía." },
      { market: "Menos de 3.5 goles", baseConfidence: 63, rationale: "Perfil de partido más táctico." },
      { market: "Más de 2.5 goles", baseConfidence: 61, rationale: "Partido con potencial de intercambio." },
    ],
    vip: [
      { market: "Hándicap asiático local -0.25", baseConfidence: 74, rationale: "Ventaja local con gestión de empate parcial." },
      { market: "Ambos equipos marcan + Más de 2.5", baseConfidence: 72, rationale: "Escenario de alta producción ofensiva." },
      { market: "Total córners: Más de 8.5", baseConfidence: 71, rationale: "Ritmo alto y amplitud por bandas." },
      { market: "Tarjetas: Más de 3.5", baseConfidence: 71, rationale: "Contexto competitivo y fricción esperada." },
      { market: "Victoria local — mercado 1X2", baseConfidence: 73, rationale: "Selección principal con valor sobre la cuota implícita." },
    ],
  },
  basketball: {
    free: [
      { market: "Más de 159.5 puntos", baseConfidence: 63, rationale: "Ritmo medio-alto esperado." },
      { market: "Local +4.5 handicap", baseConfidence: 62, rationale: "Cobertura contra cierre apretado." },
      { market: "Visitante +5.5 handicap", baseConfidence: 61, rationale: "Valor por spread amplio." },
    ],
    vip: [
      { market: "Más de 169.5 puntos", baseConfidence: 72, rationale: "Proyección ofensiva superior a media." },
      { market: "1Q más de 41.5 puntos", baseConfidence: 71, rationale: "Inicio con pace alto." },
      { market: "Local -2.5 handicap", baseConfidence: 73, rationale: "Cierre favorable por eficiencia local." },
    ],
  },
  baseball: {
    free: [
      { market: "Más de 6.5 carreras", baseConfidence: 62, rationale: "Bullpen con riesgo de concesión." },
      { market: "Menos de 9.5 carreras", baseConfidence: 61, rationale: "Duelo con control de pitcheo." },
      { market: "Run line +1.5 visitante", baseConfidence: 63, rationale: "Juego proyectado cerrado." },
    ],
    vip: [
      { market: "Run line -1.5 local", baseConfidence: 73, rationale: "Ventaja clara en abridor y lineup." },
      { market: "Más de 7.5 carreras", baseConfidence: 71, rationale: "Contexto favorable al bateo." },
      { market: "Primeras 5 entradas: local gana", baseConfidence: 72, rationale: "Edge temprano del abridor local." },
    ],
  },
  tennis: {
    free: [
      { market: "Más de 20.5 games", baseConfidence: 62, rationale: "Emparejamiento equilibrado de servicio." },
      { market: "Ganador del partido: favorito", baseConfidence: 64, rationale: "Jerarquía y forma reciente." },
    ],
    vip: [
      { market: "Ganador 2-0 sets", baseConfidence: 72, rationale: "Superioridad técnica marcada." },
      { market: "Hándicap games -2.5 favorito", baseConfidence: 71, rationale: "Dominio sostenido por consistencia." },
    ],
  },
  mma: {
    free: [
      { market: "Más de 1.5 rounds", baseConfidence: 61, rationale: "Combate con perfil táctico inicial." },
      { market: "La pelea llega a decisión: NO", baseConfidence: 62, rationale: "Estilo de finalización elevado." },
    ],
    vip: [
      { market: "Método de victoria: KO/TKO", baseConfidence: 72, rationale: "Matchup favorable de striking." },
      { market: "Victoria del favorito", baseConfidence: 74, rationale: "Ventaja integral en estadísticas clave." },
    ],
  },
  hockey: {
    free: [
      { market: "Más de 4.5 goles", baseConfidence: 62, rationale: "Ritmo y volumen de tiros consistentes." },
      { market: "Doble oportunidad local", baseConfidence: 63, rationale: "Factor local en matchups cerrados." },
    ],
    vip: [
      { market: "Más de 5.5 goles", baseConfidence: 71, rationale: "Alta varianza ofensiva proyectada." },
      { market: "Hándicap local -1.5", baseConfidence: 73, rationale: "Ventaja diferencial en transición." },
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

function parseTeams(matchText = "", league = "") {
  const normalized = String(matchText).replace(" vs ", " - ");
  const [home, away] = normalized.split(" - ").map((s) => s?.trim());
  const homeName = home || "Equipo local";
  const awayName = away || "Equipo visitante";
  return {
    homeTeam: { name: homeName, logo: resolveTeamLogoUrl(homeName, league) },
    awayTeam: { name: awayName, logo: resolveTeamLogoUrl(awayName, league) },
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
  const league = scrapedRow.league || "Auto League";
  const teams = parseTeams(scrapedRow.match, league);
  const confidence = parseConfidence(scrapedRow.probability);
  const date = scrapedRow.match_date || new Date().toISOString().slice(0, 10);
  const hours = scrapedRow.match_hour || "00:00";

  return {
    sport,
    league,
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
    return `VIP: consenso + contexto de riesgo (${source}), mayor filtro de calidad en el tip.`;
  }
  return `FREE: tip informativo por consenso estadístico (${source}) para la jornada.`;
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
        confidence: clamp(row.confidence, 58, 80),
        probability: clamp(row.confidence + 5, 55, 86),
        rationale_short: buildRationale(row, "free"),
      });
      seenMatches.add(matchKey);
      continue;
    }

    if (vip.length < limits.vip) {
      const boosted = clamp(row.confidence + 10, 68, 93);
      vip.push({
        ...row,
        prediction: ensureVipPredictionDiff(row.prediction),
        confidence: boosted,
        probability: clamp(boosted + 3, 60, 95),
        odds: estimateOddsFromConfidence(boosted),
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
      const boosted = clamp(row.confidence + 10, 68, 93);
      out.push({
        ...row,
        prediction: ensureVipPredictionDiff(row.prediction),
        confidence: boosted,
        probability: clamp(boosted + 3, 60, 95),
        odds: estimateOddsFromConfidence(boosted),
        rationale_short: buildRationale(row, "vip"),
      });
    } else {
      out.push({
        ...row,
        confidence: clamp(row.confidence, 58, 80),
        probability: clamp(row.confidence + 5, 55, 86),
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
    tier === "vip" ? 70 : 60,
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
    homeTeam: {
      name: fixture.homeTeam,
      logo: resolveTeamLogoUrl(fixture.homeTeam, fixture.league),
    },
    awayTeam: {
      name: fixture.awayTeam,
      logo: resolveTeamLogoUrl(fixture.awayTeam, fixture.league),
    },
    prediction: market.market,
    confidence,
    probability: clamp(confidence + (tier === "vip" ? 3 : 5), 50, 96),
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

    const freeMarketsPerMatch = Number.parseInt(process.env.FACTORY_RULE_MARKETS_PER_MATCH || "1", 10);
    const vipMarketsPerMatch = Math.max(1, freeMarketsPerMatch + 1);
    for (let i = 0; i < freeMarketsPerMatch && free.length < limits.free; i += 1) {
      free.push(buildPredictionFromFixture({ ...fixture, eventId: `${fixture.eventId || key}-f${i}` }, "free"));
    }
    for (let i = 0; i < vipMarketsPerMatch && vip.length < limits.vip; i += 1) {
      vip.push(buildPredictionFromFixture({ ...fixture, eventId: `${fixture.eventId || key}-v${i}` }, "vip"));
    }
    if (free.length >= limits.free && vip.length >= limits.vip) {
      break;
    }
  }

  return { free, vip };
}

function generateLiveSuggestion(match) {
  const sport = String(match.sport || "football").toLowerCase();
  const total = (match.homeGoals || 0) + (match.awayGoals || 0);
  const diff = Math.abs((match.homeGoals || 0) - (match.awayGoals || 0));
  const minute = match.minute || 0;
  const hg = match.homeGoals || 0;
  const ag = match.awayGoals || 0;
  const base = {
    sport,
    league: match.league || "Live League",
    home_team_name: match.homeTeam,
    away_team_name: match.awayTeam,
    minute,
  };

  if (minute < 0) return null;
  if (minute === 0 && total === 0) return null;

  // Football — estrategia (no spam de "otro gol")
  if (sport === "football" || sport === "soccer") {
    // Favorito aparente perdiendo / empatando tarde: next goal del que remonta (heurística de presión)
    if (minute >= 60 && minute <= 88 && diff === 1) {
      const trailing = hg < ag ? match.homeTeam : match.awayTeam;
      return {
        ...base,
        prediction: `Siguiente gol: ${trailing}`,
        confidence: 64,
        odds: 1.85,
        analysis: `Marcador cerrado ${hg}-${ag} al ${minute}'. El equipo que va abajo suele empujar; tip de remonte selectivo, no over ciego.`,
      };
    }

    // 0-0 tardío: over 0.5 restante con confianza moderada (partido puede seguir cerrado)
    if (minute >= 75 && total === 0) {
      return {
        ...base,
        prediction: "Over 0.5 goles (restante)",
        confidence: 61,
        odds: 1.55,
        analysis: `0-0 al ${minute}'. Solo tip de gol restante con confianza moderada; muchos partidos se quedan en blanco.`,
      };
    }

    // Partido abierto 1ª/2ª: BTTS si ambos ya atacan (al menos 1 gol y diff chico)
    if (minute >= 50 && minute <= 80 && total === 1 && diff === 1) {
      return {
        ...base,
        prediction: "Ambos equipos marcan: SI",
        confidence: 63,
        odds: 1.72,
        analysis: `Va ${hg}-${ag} en tramo intermedio. El que va abajo busca el empate; BTTS tiene más lógica que over agresivo.`,
      };
    }

    // Ritmo alto temprano
    if (minute >= 25 && minute <= 55 && total >= 2 && diff <= 2) {
      return {
        ...base,
        prediction: "Over 2.5 goles",
        confidence: 66,
        odds: 1.68,
        analysis: `Ritmo alto (${total} goles antes del ${minute}'). Over total coherente con el partido abierto.`,
      };
    }

    // Empate vivo mid-game: next goal / no forzar over
    if (minute >= 40 && minute <= 70 && hg === ag && total <= 2) {
      return {
        ...base,
        prediction: "Siguiente gol: cualquiera",
        confidence: 58,
        odds: 1.4,
        analysis: `Empate ${hg}-${ag} en tramo central. Preferimos next goal genérico frente a over especulativo.`,
      };
    }

    return null;
  }

  if (sport === "basketball") {
    if (minute >= 24 && total >= 100 && diff <= 14) {
      return {
        ...base,
        prediction: "Partido con ritmo: más puntos del line en vivo",
        confidence: 62,
        odds: 1.7,
        analysis: `Marcador ${hg}-${ag} con diferencia corta; ritmo sugiere over de puntos, no spread ciego.`,
      };
    }
    return null;
  }

  if (sport === "tennis") {
    if (minute > 0 && diff <= 1) {
      return {
        ...base,
        prediction: "Set competitivo — favorito a cerrar si mantiene servicio",
        confidence: 57,
        odds: 1.65,
        analysis: "Lectura conservadora en vivo: solo tip si el set sigue reñido.",
      };
    }
    return null;
  }

  if (sport === "hockey") {
    if (minute >= 30 && total <= 3 && diff <= 1) {
      return {
        ...base,
        prediction: "Over 4.5 goles totales (ritmo)",
        confidence: 60,
        odds: 1.75,
        analysis: `Hockey ${hg}-${ag} con margen corto; over total solo con ritmo razonable.`,
      };
    }
    return null;
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
