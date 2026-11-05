const { normalizeMatchDate } = require("./helpers");

/**
 * Normaliza texto de mercado para detectar duplicados (Over 1.5 vs Over 1.5 goles).
 */
function normalizePickLabel(label = "") {
  return String(label)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ó/g, "o")
    .replace(/goal/g, "gol")
    .replace(/goles/g, "gol")
    .replace(/asian handicap|handicap asiatico|h'cap|ah\b/g, "handicap")
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pairKey(home = "", away = "") {
  return `${String(home).toLowerCase().trim()}|${String(away).toLowerCase().trim()}`;
}

function normalizeTeamToken(name = "") {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(fc|cf|afc|sc|ac|as|cd|ud|rcd|club|de|the|united)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lee el local desde cualquiera de las formas que usan cola, planta y API. */
function pickHomeTeam(pick = {}) {
  return (
    pick.homeTeam?.name ||
    pick.home_team ||
    pick.home_team_name ||
    pick.team_a ||
    pick.home ||
    ""
  );
}

function pickAwayTeam(pick = {}) {
  return (
    pick.awayTeam?.name ||
    pick.away_team ||
    pick.away_team_name ||
    pick.team_b ||
    pick.away ||
    ""
  );
}

function pickMatchDate(pick = {}) {
  return (
    normalizeMatchDate(pick.date || pick.match_date) ||
    String(pick.date || pick.match_date || "").slice(0, 10)
  );
}

function pickPredictionLabel(pick = {}) {
  return pick.prediction || pick.pick_text || pick.pick || "";
}

/** Un pronóstico por partido y día (free o vip se filtra aparte en el pipeline). */
function fixtureTierDedupeKey(pick) {
  const home = normalizeTeamToken(pickHomeTeam(pick));
  const away = normalizeTeamToken(pickAwayTeam(pick));
  const date = pickMatchDate(pick);
  const sport = String(pick.sport || "football").toLowerCase();
  return `${sport}|${pairKey(home, away)}|${date}`;
}

/** Duplicado lógico: mismo cruce + día + mismo mercado (texto normalizado). */
function marketDedupeKey(pick) {
  return `${fixtureTierDedupeKey(pick)}|${normalizePickLabel(pickPredictionLabel(pick))}`;
}

/** Duplicado lógico: mismo cruce + mismo mercado (texto normalizado). */
function liveSignalDedupeKey(sport, home, away, prediction) {
  const s = String(sport || "football").toLowerCase();
  return `${s}|${pairKey(normalizeTeamToken(home), normalizeTeamToken(away))}|${normalizePickLabel(prediction)}`;
}

/**
 * Fusiona listas en orden de prioridad (primera lista gana la clave).
 * `keyFn` recibe un elemento y devuelve string única por duplicado lógico.
 */
function mergeDedupeByKey(lists, keyFn) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const key = keyFn(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

module.exports = {
  normalizePickLabel,
  pairKey,
  normalizeTeamToken,
  pickHomeTeam,
  pickAwayTeam,
  pickMatchDate,
  pickPredictionLabel,
  fixtureTierDedupeKey,
  marketDedupeKey,
  liveSignalDedupeKey,
  mergeDedupeByKey,
};
