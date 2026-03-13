const axios = require("axios");
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
  const events = await fetchEspnScoreboardRaw(sport, effectiveDateIso);

  const fixtures = events
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

  return fixtures;
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
    .filter((row) => row.status === "in");

  return liveRows;
}

module.exports = {
  getSupportedSports,
  validateSport,
  getFactoryTimezone,
  getTodayFixturesBySport,
  getLiveMatchesBySport,
};
