/**
 * Normaliza texto de mercado para detectar duplicados (Over 1.5 vs Over 1.5 goles).
 */
function normalizePickLabel(label = "") {
  return String(label)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/goal/g, "gol")
    .replace(/goles/g, "gol")
    .replace(/ó/g, "o")
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
    .replace(/\s+/g, " ")
    .trim();
}

/** Un pronóstico por partido y día (free o vip se filtra aparte en el pipeline). */
function fixtureTierDedupeKey(pick) {
  const home = normalizeTeamToken(pick.homeTeam?.name || pick.home_team_name || pick.team_a || "");
  const away = normalizeTeamToken(pick.awayTeam?.name || pick.away_team_name || pick.team_b || "");
  const date = String(pick.date || pick.match_date || "").slice(0, 10);
  const sport = String(pick.sport || "football").toLowerCase();
  return `${sport}|${pairKey(home, away)}|${date}`;
}

/** Duplicado lógico: mismo cruce + mismo mercado (texto normalizado). */
function liveSignalDedupeKey(sport, home, away, prediction) {
  const s = String(sport || "football").toLowerCase();
  return `${s}|${pairKey(home, away)}|${normalizePickLabel(prediction)}`;
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
  fixtureTierDedupeKey,
  liveSignalDedupeKey,
  mergeDedupeByKey,
};
