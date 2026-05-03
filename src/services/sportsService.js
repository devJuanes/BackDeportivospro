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

/** Deportes que ejecuta la fábrica (predictions + live monitor). Respeta FACTORY_SPORTS; si no hay env, fútbol + NBA + tenis + hockey. */
function getFactorySports() {
  const raw = process.env.FACTORY_SPORTS;
  if (!raw) {
    return ["football", "basketball", "tennis", "hockey"];
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

/** Convierte eventos JSON del scoreboard ESPN (fútbol) en filas normalizadas del pipeline. */
function mapEspnEventsToFootballFixtures(events, effectiveDateIso, sport = "football") {
  const timezone = getFactoryTimezone();
  return events
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
}

/** Slugs ESPN `soccer/{liga}` con partidos LATAM (no usar solo soccer/all + filtro texto). */
const DEFAULT_LATAM_ESPN_SOCCER_PATHS = [
  "soccer/col.1",
  "soccer/arg.1",
  "soccer/ecu.1",
  "soccer/per.1",
  "soccer/bra.1",
  "soccer/bra.2",
  "soccer/mex.1",
  "soccer/chi.1",
  "soccer/uru.1",
  "soccer/par.1",
  "soccer/bol.1",
  "soccer/ven.1",
  "soccer/conmebol.libertadores",
  "soccer/conmebol.sudamericana",
  "soccer/conmebol.recopa",
];

function getLatamEspnSoccerPaths() {
  const raw = process.env.FACTORY_LATAM_ESPN_PATHS;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_LATAM_ESPN_SOCCER_PATHS;
}

async function fetchEspnSoccerLeagueScoreboardEvents(leagueFullPath, effectiveDateIso) {
  const dateCompact = isoDateToCompact(effectiveDateIso);
  const url = `https://site.api.espn.com/apis/site/v2/sports/${leagueFullPath}/scoreboard?dates=${dateCompact}`;
  const { data } = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  return Array.isArray(data?.events) ? data.events : [];
}

/**
 * Partidos del día para fábrica LATAM: une scoreboards por liga ESPN + TSDB filtrado.
 * Evita depender de `soccer/all`, donde los cruces europeos suelen comerse el cupo y el filtro por texto deja 0 filas.
 */
async function getTodayFootballFixturesLatam(dateIso = null) {
  const timezone = getFactoryTimezone();
  const effectiveDateIso = dateIso || formatDateInTimezone(new Date(), timezone);
  const paths = getLatamEspnSoccerPaths();
  const settled = await Promise.allSettled(
    paths.map((p) => fetchEspnSoccerLeagueScoreboardEvents(p, effectiveDateIso))
  );

  const seenPair = new Set();
  const merged = [];

  settled.forEach((r, idx) => {
    const leaguePath = paths[idx];
    if (r.status !== "fulfilled") {
      logger.warn(`ESPN LATAM (${leaguePath}): ${r.reason?.message || String(r.reason)}`);
      return;
    }
    const rows = mapEspnEventsToFootballFixtures(r.value, effectiveDateIso);
    for (const row of rows) {
      const k = `${String(row.homeTeam).toLowerCase()}|${String(row.awayTeam).toLowerCase()}`;
      if (seenPair.has(k)) continue;
      seenPair.add(k);
      merged.push({ ...row, source: "espn_latam", espn_league_path: leaguePath });
    }
  });

  try {
    if (process.env.THESPORTSDB_DISABLED !== "true") {
      const { filterFootballFixturesLatam } = require("../utils/latamFixtures");
      const tsdb = await getTheSportsDbEventsByDay("football", effectiveDateIso, timezone);
      const latamTsdb = filterFootballFixturesLatam(tsdb);
      let tsdbAdded = 0;
      for (const row of latamTsdb) {
        const k = `${String(row.homeTeam).toLowerCase()}|${String(row.awayTeam).toLowerCase()}`;
        if (seenPair.has(k)) continue;
        seenPair.add(k);
        merged.push(row);
        tsdbAdded += 1;
      }
      if (tsdbAdded > 0) {
        logger.info(`LATAM: +${tsdbAdded} partidos extra desde TheSportsDB (${effectiveDateIso})`);
      }
    }
  } catch (error) {
    logger.warn(`TheSportsDB merge LATAM: ${error.message}`);
  }

  try {
    const { isConfigured, getSoccersFootballFixturesForDate } = require("./soccersApiService");
    if (isConfigured()) {
      const soc = await getSoccersFootballFixturesForDate(effectiveDateIso);
      let added = 0;
      for (const row of soc) {
        const k = `${String(row.homeTeam).toLowerCase()}|${String(row.awayTeam).toLowerCase()}`;
        if (seenPair.has(k)) continue;
        seenPair.add(k);
        merged.push(row);
        added += 1;
      }
      if (added > 0) {
        logger.info(`LATAM: +${added} fixtures desde SoccersAPI (${effectiveDateIso})`);
      }
    }
  } catch (error) {
    logger.warn(`SoccersAPI merge LATAM: ${error.message}`);
  }

  if (merged.length > 0) {
    try {
      await upsertFixtures(
        merged.map((row) => ({
          ...row,
          source: row.source || "espn_latam",
          source_event_id: row.eventId,
          raw_payload: null,
        }))
      );
    } catch (error) {
      logger.warn(`No se pudo guardar caché fixtures LATAM: ${error.message}`);
    }
    logger.info(`LATAM: ${merged.length} fixtures para ${effectiveDateIso} (ESPN ${paths.length} rutas de liga)`);
    return merged;
  }

  try {
    const cached = await getFixturesByDateSport(effectiveDateIso, "football");
    const { filterFootballFixturesLatam } = require("../utils/latamFixtures");
    const mapped = cached.map((row) => ({
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
    const fallback = filterFootballFixturesLatam(mapped);
    logger.warn(`LATAM: ESPN devolvió 0 para ${effectiveDateIso}; caché filtrada → ${fallback.length} fixtures`);
    return fallback;
  } catch (error) {
    logger.warn(`LATAM sin datos (${effectiveDateIso}): ${error.message}`);
    return [];
  }
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

  const fixturesFromSource = mapEspnEventsToFootballFixtures(events, effectiveDateIso, sport);

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
  getTodayFootballFixturesLatam,
  getLiveMatchesBySport,
};
