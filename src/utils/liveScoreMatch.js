/**
 * Empareja partidos live con tips sin mezclar deportes ni marcadores imposibles.
 */
const { normalizeTeamToken } = require("./predictionDedupe");

function normalizeSport(sport) {
  const s = String(sport || "football").toLowerCase().trim();
  if (s === "soccer") return "football";
  return s || "football";
}

/** Match estricto: igualdad o substring solo si el token corto tiene ≥6 chars. */
function teamsStrictMatch(a, b) {
  const na = normalizeTeamToken(a);
  const nb = normalizeTeamToken(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 6) return false;
  return long.includes(short);
}

function teamsExactMatch(a, b) {
  return normalizeTeamToken(a) === normalizeTeamToken(b) && Boolean(normalizeTeamToken(a));
}

/**
 * Rechaza marcadores que no pueden ser de ese deporte
 * (ej. 79-92 en fútbol = leak de basketball).
 */
function isPlausibleScore(sport, homeGoals, awayGoals, minute = 0) {
  const s = normalizeSport(sport);
  const hg = Number(homeGoals);
  const ag = Number(awayGoals);
  const m = Number(minute) || 0;
  if (!Number.isFinite(hg) || !Number.isFinite(ag) || hg < 0 || ag < 0) return false;
  if (m < 0) return false;

  if (s === "football") {
    if (hg > 15 || ag > 15) return false;
    if (m > 130) return false;
    return true;
  }
  if (s === "basketball") {
    if (hg > 200 || ag > 200) return false;
    if (m > 60) return false;
    return true;
  }
  if (s === "hockey") {
    if (hg > 20 || ag > 20) return false;
    if (m > 100) return false;
    return true;
  }
  if (s === "tennis") {
    if (hg > 7 || ag > 7) return false;
    return true;
  }
  return hg <= 50 && ag <= 50;
}

/**
 * Busca el partido live correcto para un tip.
 * Filtra por sport; si hay varios fuzzy, no aplica (evita leaks).
 * @returns {null | { homeGoals, awayGoals, minute, status, swapped, eventId }}
 */
function findLiveMatch(activeMatches, home, away, sport) {
  const want = normalizeSport(sport);
  const pool = (activeMatches || []).filter((m) => normalizeSport(m.sport) === want);
  const hits = [];

  for (const m of pool) {
    const direct =
      teamsStrictMatch(m.homeTeam, home) && teamsStrictMatch(m.awayTeam, away);
    const swapped =
      teamsStrictMatch(m.homeTeam, away) && teamsStrictMatch(m.awayTeam, home);
    if (!direct && !swapped) continue;
    const exact =
      (teamsExactMatch(m.homeTeam, home) && teamsExactMatch(m.awayTeam, away)) ||
      (teamsExactMatch(m.homeTeam, away) && teamsExactMatch(m.awayTeam, home));
    hits.push({ m, swapped: swapped && !direct, exact });
  }

  if (!hits.length) return null;
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  if (!hits[0].exact && hits.length > 1) return null;

  const { m, swapped } = hits[0];
  let homeGoals = Number(m.homeGoals) || 0;
  let awayGoals = Number(m.awayGoals) || 0;
  if (swapped) {
    const tmp = homeGoals;
    homeGoals = awayGoals;
    awayGoals = tmp;
  }
  const minute = Number(m.minute) || 0;
  if (!isPlausibleScore(want, homeGoals, awayGoals, minute)) return null;

  return {
    homeGoals,
    awayGoals,
    minute,
    status: m.status,
    eventId: m.eventId || m.source_event_id || null,
    swapped,
  };
}

module.exports = {
  normalizeSport,
  teamsStrictMatch,
  teamsExactMatch,
  isPlausibleScore,
  findLiveMatch,
};
