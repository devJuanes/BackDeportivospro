/**
 * TheSportsDB v1 — respaldo gratuito de fixtures cuando ESPN no responde o no cubre la liga.
 * Docs: https://www.thesportsdb.com/api.php  (key pública "3" para uso libre).
 *
 * Sólo lo usamos como FALLBACK en `sportsService.getTodayFixturesBySport`.
 * Cobertura útil para Latam (Liga BetPlay, Liga Pro, Liga 1 Perú, Brasileirão, etc.).
 */
const axios = require("axios");
const logger = require("../utils/logger");
const { formatDateInTimezone, formatHourInTimezone } = require("../utils/helpers");

const SPORTS_DB_PATH = {
  football: "Soccer",
  basketball: "Basketball",
  baseball: "Baseball",
  tennis: "Tennis",
  hockey: "Ice Hockey",
  mma: "Fighting",
};

function apiKey() {
  return (process.env.THESPORTSDB_KEY || "3").trim() || "3";
}

function baseUrl() {
  return `https://www.thesportsdb.com/api/v1/json/${apiKey()}`;
}

function parseEventDate(event) {
  // Combinamos dateEvent (YYYY-MM-DD) + strTime (HH:MM:SS UTC). Si no hay strTime, asumimos 00:00 UTC.
  const date = event.dateEvent || event.dateEventLocal;
  const time = event.strTime || event.strTimeLocal || "00:00:00";
  if (!date) return null;
  const iso = `${date}T${time.slice(0, 8)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapEventToFixture(event, sport, timezone) {
  const eventDate = parseEventDate(event);
  if (!eventDate) return null;
  return {
    eventId: `tsdb-${event.idEvent}`,
    sport,
    league: event.strLeague || "League",
    match_date: formatDateInTimezone(eventDate, timezone),
    match_hour: formatHourInTimezone(eventDate, timezone),
    homeTeam: event.strHomeTeam || "Local",
    awayTeam: event.strAwayTeam || "Visitante",
    homeGoals: Number.parseInt(event.intHomeScore || "0", 10) || 0,
    awayGoals: Number.parseInt(event.intAwayScore || "0", 10) || 0,
    status: event.strStatus === "Match Finished" ? "post" : "pre",
    minute: 0,
    source: "thesportsdb",
  };
}

/**
 * Lista eventos de un día específico para un deporte.
 * @param {string} sport
 * @param {string} dateIso YYYY-MM-DD (en TZ del servidor, no de la liga)
 * @param {string} timezone TZ destino para `match_date` / `match_hour`
 * @returns {Promise<Array>}
 */
async function getEventsByDay(sport, dateIso, timezone) {
  const sportName = SPORTS_DB_PATH[sport];
  if (!sportName) return [];
  const url = `${baseUrl()}/eventsday.php?d=${encodeURIComponent(dateIso)}&s=${encodeURIComponent(sportName)}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    const events = Array.isArray(data?.events) ? data.events : [];
    const fixtures = [];
    for (const ev of events) {
      const f = mapEventToFixture(ev, sport, timezone);
      if (f && f.match_date === dateIso) fixtures.push(f);
    }
    return fixtures;
  } catch (error) {
    logger.warn(`TheSportsDB fallback (${sport}, ${dateIso}): ${error.message}`);
    return [];
  }
}

module.exports = {
  getEventsByDay,
};
