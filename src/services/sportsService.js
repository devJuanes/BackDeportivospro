const axios = require("axios");
const logger = require("../utils/logger");
const { upsertFixtures, getFixturesByDateSport } = require("../models/fixtureModel");
const { getEventsByDay: getTheSportsDbEventsByDay } = require("./theSportsDbService");
const {
  formatDateInTimezone,
  formatHourInTimezone,
  isoDateToCompact,
  clamp,
} = require("../utils/helpers");

const SUPPORTED_SPORTS = [
  "football",
  "basketball",
  "tennis",
  "baseball",
  "mma",
  "hockey",
  "esports",
];

const ESPN_PATH_BY_SPORT = {
  football: "soccer/all",
  basketball: "basketball/nba",
  tennis: "tennis/all",
  baseball: "baseball/mlb",
  mma: "mma/ufc",
  hockey: "hockey/nhl",
  esports: "esports/league-of-legends",
};

function getSupportedSports() {
  return SUPPORTED_SPORTS;
}

/** Deportes que ejecuta la fábrica (predictions + live monitor). Respeta FACTORY_SPORTS; por defecto solo fútbol. */
function getFactorySports() {
  const raw = process.env.FACTORY_SPORTS;
  if (!raw) {
    return ["football"];
  }
  const allowed = new Set(SUPPORTED_SPORTS);
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((s) => allowed.has(s));
  return parsed.length > 0 ? parsed : ["football"];
}

function validateSport(sport) {
  return SUPPORTED_SPORTS.includes(sport);
}

function getFactoryTimezone() {
  return process.env.FACTORY_TIMEZONE || "America/Bogota";
}

function parseCompetitors(event) {
  const competitors = event?.competitions?.[0]?.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
  const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
  return {
    homeTeam: home?.team?.displayName || "Local",
    awayTeam: away?.team?.displayName || "Visitante",
    homeScore: Number.parseInt(home?.score || "0", 10) || 0,
    awayScore: Number.parseInt(away?.score || "0", 10) || 0,
  };
}

function parseLeague(event) {
  return (
    event?.competitions?.[0]?.league?.name ||
    event?.league?.name ||
    event?.shortName ||
    "League"
  );
}

async function fetchEspnScoreboardRaw(sport = "football", dateIso = null) {
  const path = ESPN_PATH_BY_SPORT[sport] || ESPN_PATH_BY_SPORT.football;
  const timezone = getFactoryTimezone();
  const effectiveDateIso = dateIso || formatDateInTimezone(new Date(), timezone);
  const dateCompact = isoDateToCompact(effectiveDateIso);
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${dateCompact}`;

  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  return data?.events || [];
}

function normalizeMinuteBySport(statusShort = "", sport = "football") {
  const numeric = Number.parseInt(String(statusShort).replace(/[^\d]/g, ""), 10) || 0;
  if (sport === "basketball") {
    return clamp(numeric * 10, 0, 48);
  }
  if (sport === "baseball") {
    return clamp(numeric * 10, 0, 90);
  }
  return clamp(numeric, 0, 130);
}

async function getTodayFixturesBySport(sport = "football", dateIso = null) {
  const timezone = getFactoryTimezone();
  const effectiveDateIso = dateIso || formatDateInTimezone(new Date(), timezone);
  let events = [];
  try {
    events = await fetchEspnScoreboardRaw(sport, effectiveDateIso);
  } catch (error) {
    logger.warn(`Fuente ESPN no disponible (${sport}): ${error.message}`);
  }

  const fixturesFromSource = events
    .map((event) => {
      const teams = parseCompetitors(event);
      const eventDate = new Date(event.date);
      const statusType = event?.status?.type?.state || "pre";
      const statusShort = event?.status?.type?.shortDetail || "";
      return {
        eventId: event.id,
        sport,
        league: parseLeague(event),
        match_date: formatDateInTimezone(eventDate, timezone),
        match_hour: formatHourInTimezone(eventDate, timezone),
        homeTeam: teams.homeTeam,
        awayTeam: teams.awayTeam,
        homeGoals: teams.homeScore,
        awayGoals: teams.awayScore,
        status: statusType,
        minute: normalizeMinuteBySport(statusShort, sport),
      };
    })
    .filter((row) => row.match_date === effectiveDateIso);

  /** Respaldo: TheSportsDB para días en los que ESPN no devuelve nada (típico de ligas Latam). */
  let merged = [...fixturesFromSource];
  try {
    if (process.env.THESPORTSDB_DISABLED !== "true") {
      const tsdb = await getTheSportsDbEventsByDay(sport, effectiveDateIso, timezone);
      if (tsdb.length > 0) {
        const seen = new Set(
          merged.map((r) => `${r.homeTeam.toLowerCase()}|${r.awayTeam.toLowerCase()}`)
        );
        for (const row of tsdb) {
          const k = `${row.homeTeam.toLowerCase()}|${row.awayTeam.toLowerCase()}`;
          if (!seen.has(k)) {
            merged.push(row);
            seen.add(k);
          }
        }
        if (fixturesFromSource.length === 0) {
          logger.info(`TheSportsDB cubrió ${tsdb.length} fixtures (${sport}, ${effectiveDateIso}) — ESPN no devolvió eventos.`);
        } else if (tsdb.length > 0) {
          logger.info(`TheSportsDB añadió ${merged.length - fixturesFromSource.length} fixtures extra (${sport}, ${effectiveDateIso}).`);
        }
      }
    }
  } catch (error) {
    logger.warn(`TheSportsDB respaldo falló (${sport}): ${error.message}`);
  }

  if (merged.length > 0) {
    try {
      await upsertFixtures(
        merged.map((row) => ({
          ...row,
          source: row.source || "espn",
          source_event_id: row.eventId,
          raw_payload: null,
        }))
      );
    } catch (error) {
      logger.warn(`No se pudo guardar caché de fixtures (${sport}): ${error.message}`);
    }
    return merged;
  }

  try {
    const cached = await getFixturesByDateSport(effectiveDateIso, sport);
    return cached.map((row) => ({
      eventId: row.source_event_id,
      sport: row.sport,
      league: row.league,
      match_date: row.match_date,
      match_hour: row.match_hour,
      homeTeam: row.team_a,
      awayTeam: row.team_b,
      homeGoals: row.home_goals,
      awayGoals: row.away_goals,
      status: row.status,
      minute: row.minute,
    }));
  } catch (error) {
    logger.warn(`No se pudo usar caché de fixtures (${sport}): ${error.message}`);
    return [];
  }
}

async function getLiveMatchesBySport(sport = "football") {
  const events = await fetchEspnScoreboardRaw(sport, null);
  const liveRows = events
    .map((event) => {
      const teams = parseCompetitors(event);
      const statusType = event?.status?.type?.state || "pre";
      const statusShort = event?.status?.type?.shortDetail || "";
      return {
        sport,
        league: parseLeague(event),
        homeTeam: teams.homeTeam,
        awayTeam: teams.awayTeam,
        minute: normalizeMinuteBySport(statusShort, sport),
        homeGoals: teams.homeScore,
        awayGoals: teams.awayScore,
        status: statusType,
        status_short: statusShort,
      };
    })
    .filter((row) => {
      if (row.status !== "in") {
        return false;
      }
      /** Evita “en vivo” fantasma: partido marcado in pero sin tiempo ni marcador ni detalle útil. */
      if (sport === "football") {
        const min = row.minute || 0;
        const scored = (row.homeGoals || 0) + (row.awayGoals || 0) > 0;
        if (min >= 1 || scored) {
          return true;
        }
        return /\d/.test(String(row.status_short || ""));
      }
      return true;
    });

  return liveRows;
}

module.exports = {
  getSupportedSports,
  getFactorySports,
  validateSport,
  getFactoryTimezone,
  getTodayFixturesBySport,
  getLiveMatchesBySport,
};
