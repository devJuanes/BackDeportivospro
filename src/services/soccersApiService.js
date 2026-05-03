/**
 * SoccersAPI v2.2 — fixtures por fecha (respaldo LATAM si ESPN falla o cubre poco).
 * Docs: https://docs.soccersapi.com/fixtures-by-date-6032933e0
 *
 * Credenciales SOLO por entorno (nunca en código):
 *   SOCCERSAPI_USER, SOCCERSAPI_TOKEN
 * Opcional:
 *   SOCCERSAPI_LEAGUE_IDS=id1,id2 — si el schedule global viene vacío en tu plan, pide por liga.
 *   SOCCERSAPI_LATAM_CC=co,ar,ec,... — filtro país (ISO2); vacío = no filtrar por país.
 */
const axios = require("axios");
const logger = require("../utils/logger");
const { formatDateInTimezone, formatHourInTimezone } = require("../utils/helpers");

const BASE_URL = "https://api.soccersapi.com/v2.2/fixtures/";

function getCredentials() {
  const user = process.env.SOCCERSAPI_USER?.trim();
  const token = process.env.SOCCERSAPI_TOKEN?.trim();
  if (!user || !token) return null;
  return { user, token };
}

function isConfigured() {
  return getCredentials() !== null;
}

function latamCountryCodes() {
  const raw = process.env.SOCCERSAPI_LATAM_CC;
  if (raw !== undefined && String(raw).trim() === "") {
    return null;
  }
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return ["co", "ar", "ec", "pe", "br", "mx", "cl", "uy", "py", "bo", "ve"];
}

function leagueIdsFromEnv() {
  const raw = process.env.SOCCERSAPI_LEAGUE_IDS;
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchSchedulePage(dateIso, page, extraParams = {}) {
  const c = getCredentials();
  if (!c) throw new Error("SoccersAPI no configurada");
  const { data } = await axios.get(BASE_URL, {
    timeout: 28000,
    params: {
      user: c.user,
      token: c.token,
      t: "schedule",
      d: dateIso,
      page,
      ...extraParams,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "MatuPicks-BackDeportivospro/1.0",
    },
  });
  return data;
}

async function fetchScheduleAllPages(dateIso, extraParams = {}) {
  const rows = [];
  let page = 1;
  let pages = 1;
  const maxPages = Math.min(50, Number.parseInt(process.env.SOCCERSAPI_MAX_PAGES || "25", 10));

  do {
    let data;
    try {
      data = await fetchSchedulePage(dateIso, page, extraParams);
    } catch (error) {
      const msg = error?.response?.data?.meta?.msg || error.message;
      throw new Error(msg || String(error));
    }
    const chunk = Array.isArray(data?.data) ? data.data : [];
    rows.push(...chunk);
    pages = Number(data?.meta?.pages) || 1;
    page += 1;
  } while (page <= pages && page <= maxPages);

  return rows;
}

function extractTeamName(teamObj) {
  if (!teamObj) return "";
  if (typeof teamObj === "string") return teamObj.trim();
  return String(teamObj.name || teamObj.common_name || teamObj.title || "").trim();
}

function extractScores(row) {
  let h =
    row.home_score ??
    row.home_goals ??
    row.scores?.home ??
    row.home_team?.goals ??
    row.home_ft_goals;
  let a =
    row.away_score ??
    row.away_goals ??
    row.scores?.away ??
    row.away_team?.goals ??
    row.away_ft_goals;

  const scoreStr = row.score || row.result || row.ft_score;
  if ((h == null || h === "") && typeof scoreStr === "string") {
    const m = scoreStr.match(/(\d+)\s*[-–:]\s*(\d+)/);
    if (m) {
      h = Number.parseInt(m[1], 10);
      a = Number.parseInt(m[2], 10);
    }
  }

  h = Number.parseInt(h, 10);
  a = Number.parseInt(a, 10);
  if (Number.isNaN(h)) h = 0;
  if (Number.isNaN(a)) a = 0;
  return { homeGoals: h, awayGoals: a };
}

function inferEspnLikeStatus(row, homeGoals, awayGoals) {
  const statusRaw = String(
    row.status_name || row.status?.name || row.time?.status || row.fixture_status || row.status || "",
  ).toLowerCase();
  if (/ft|finished|completed|full|finalizado|jugado|walkover|wo\b|award/i.test(statusRaw)) {
    return "post";
  }
  if (/live|1st|2nd|ht|halftime|in play|2nd half/i.test(statusRaw)) {
    return "in";
  }
  if (/postponed|cancelled|canceled|abandon/i.test(statusRaw)) {
    return "pre";
  }
  if (homeGoals > 0 || awayGoals > 0) {
    return "post";
  }
  return "pre";
}

function mapRowToFixture(row, timezone, calendarDateIso, sport = "football") {
  const homeTeam = extractTeamName(row.home_team) || extractTeamName(row.local_team) || "Local";
  const awayTeam = extractTeamName(row.away_team) || extractTeamName(row.visitor_team) || "Visitante";
  const league =
    row.league?.name ||
    row.competition?.name ||
    row.league_name ||
    row.season?.name ||
    row.tournament?.name ||
    "League";

  const { homeGoals, awayGoals } = extractScores(row);
  const ts = row.timestamp || row.datetime || row.date || row.date_start || row.starting_at || row.time?.starting_at;
  let eventDate = null;
  if (typeof ts === "number" && ts > 1e9) {
    eventDate = new Date(ts * 1000);
  } else if (ts) {
    eventDate = new Date(ts);
  }
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    eventDate = new Date(`${calendarDateIso}T15:00:00`);
  }

  const match_date = formatDateInTimezone(eventDate, timezone);
  const match_hour = formatHourInTimezone(eventDate, timezone);
  const status = inferEspnLikeStatus(row, homeGoals, awayGoals);

  return {
    eventId: `soccers-${row.id || row.fixture_id || `${homeTeam}-${awayTeam}-${calendarDateIso}`}`,
    sport,
    league,
    match_date,
    match_hour,
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    status,
    minute: status === "post" ? 90 : Number.parseInt(row.minute || row.time?.minute || "0", 10) || 0,
    source: "soccersapi",
    soccers_country_code: row.country_code || row.cc || row.country?.cc || null,
  };
}

/**
 * Partidos fútbol desde SoccersAPI para un día calendario (zona fábrica).
 * Filtra por país LATAM si hay `country_code` en las filas; si no viene, se incluye el partido.
 */
async function getSoccersFootballFixturesForDate(dateIso) {
  if (!isConfigured()) return [];

  const timezone = process.env.FACTORY_TIMEZONE || "America/Bogota";
  const allowedCc = latamCountryCodes();
  const allowedSet = allowedCc ? new Set(allowedCc) : null;
  const leagueIds = leagueIdsFromEnv();

  let raw = [];
  try {
    raw = await fetchScheduleAllPages(dateIso, {});
  } catch (error) {
    logger.warn(`SoccersAPI schedule (sin league_id): ${error.message}`);
  }

  if (raw.length === 0 && leagueIds.length > 0) {
    for (const lid of leagueIds) {
      try {
        const part = await fetchScheduleAllPages(dateIso, { league_id: lid });
        raw.push(...part);
      } catch (error) {
        logger.warn(`SoccersAPI league_id=${lid}: ${error.message}`);
      }
    }
  }

  const fixtures = [];
  const seen = new Set();
  let skippedCc = 0;

  for (const row of raw) {
    const cc = String(row.country_code || row.cc || row.country?.cc || "").toLowerCase();
    if (allowedSet && cc && !allowedSet.has(cc)) {
      skippedCc += 1;
      continue;
    }

    const f = mapRowToFixture(row, timezone, dateIso);
    if (f.match_date !== dateIso) continue;
    const k = `${f.homeTeam.toLowerCase()}|${f.awayTeam.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fixtures.push(f);
  }

  if (fixtures.length > 0) {
    logger.info(
      `SoccersAPI: ${fixtures.length} fixtures para ${dateIso}${skippedCc ? ` (${skippedCc} fuera de LATAM-cc)` : ""}`,
    );
  } else if (raw.length > 0) {
    logger.warn(
      `SoccersAPI devolvió ${raw.length} filas pero 0 pasaron filtro/fecha ${dateIso}. Revisa SOCCERSAPI_LATAM_CC o datos.`,
    );
  }

  return fixtures;
}

module.exports = {
  isConfigured,
  getSoccersFootballFixturesForDate,
  getCredentials,
};
