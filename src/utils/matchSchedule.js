const { formatDateInTimezone, normalizeMatchDate } = require("./helpers");
const { normalizeMatchHour } = require("./matchHour");

const TOP_TIERS = new Set(["top", "super"]);
const LIVE_WINDOW_MIN = Number.parseInt(process.env.MATCH_LIVE_WINDOW_MIN || "115", 10);

function getTimezone() {
  return process.env.FACTORY_TIMEZONE || "America/Bogota";
}

/** Convierte fecha+hora local (zona proyecto) a instante UTC. */
function localDateTimeToUtc(y, mo, d, hh, mm, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const target = Date.UTC(y, mo - 1, d, hh, mm, 0);
    const diff = target - asUtc;
    guess += diff;
    if (diff === 0) break;
  }
  return guess;
}

/** Parsea match_date + match_hour a Date UTC. */
function parseKickoff(matchDate, matchHour, timezone = getTimezone()) {
  const date = normalizeMatchDate(matchDate, timezone);
  if (!date) return null;

  const hour = normalizeMatchHour(matchHour);
  const [y, mo, d] = date.split("-").map((n) => Number.parseInt(n, 10));
  const [hh, mm] = hour.split(":").map((n) => Number.parseInt(n, 10));
  if (!y || !mo || !d) return null;

  try {
    return new Date(localDateTimeToUtc(y, mo, d, hh, mm, timezone));
  } catch {
    return null;
  }
}

function formatKickoffDisplay(matchDate, matchHour, timezone = getTimezone()) {
  const date = normalizeMatchDate(matchDate, timezone);
  const hour = normalizeMatchHour(matchHour);
  if (!date) return hour;

  const kick = parseKickoff(date, hour, timezone);
  if (!kick || Number.isNaN(kick.getTime())) {
    return `${date} ${hour}`;
  }

  return new Intl.DateTimeFormat("es-CO", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(kick);
}

/** Solo hora con AM/PM (ej. "5:30 p. m."). */
function formatKickoffTimeOnly(matchDate, matchHour, timezone = getTimezone()) {
  const date = normalizeMatchDate(matchDate, timezone);
  const hour = normalizeMatchHour(matchHour);
  if (!date) return hour;
  const kick = parseKickoff(date, hour, timezone);
  if (!kick || Number.isNaN(kick.getTime())) return hour;
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(kick);
}

function todayMatchDate(timezone = getTimezone()) {
  return formatDateInTimezone(new Date(), timezone);
}

function kickoffSortKey(row) {
  const kick = parseKickoff(row.match_date, row.match_hour);
  if (!kick || Number.isNaN(kick.getTime())) {
    return `${normalizeMatchDate(row.match_date) || "9999"}T99:99`;
  }
  return kick.toISOString();
}

function sortByKickoffAsc(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ka = kickoffSortKey(a);
    const kb = kickoffSortKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ca = Number(b.confidence) || 0;
    const cb = Number(a.confidence) || 0;
    return ca - cb;
  });
}

function mapStatusLocal(raw) {
  const s = String(raw || "pending").toLowerCase();
  if (s === "ganada" || s === "won") return "won";
  if (s === "perdida" || s === "lost") return "lost";
  if (s === "live" || s === "en_vivo") return "live";
  if (s === "void" || s === "anulada") return "void";
  return "pending";
}

function resolveMatchPhase(row, now = new Date()) {
  const status = mapStatusLocal(row.status);
  if (status === "won" || status === "lost" || status === "void") return "finished";
  if (row.is_live || status === "live") return "live";

  const kick = parseKickoff(row.match_date, row.match_hour);
  if (!kick || Number.isNaN(kick.getTime())) return "upcoming";

  const diffMin = (kick.getTime() - now.getTime()) / 60_000;
  if (diffMin > 5) return "upcoming";
  if (diffMin > -LIVE_WINDOW_MIN) return "live";
  if (status === "pending") return "finished";
  return "finished";
}

function isTopPick(row) {
  const tier = String(row.tier || "").toLowerCase();
  if (TOP_TIERS.has(tier)) return true;
  const conf = Number(row.confidence) || 0;
  return conf >= 88;
}

function partitionPredictions(rows, now = new Date()) {
  const sorted = sortByKickoffAsc(rows);
  const live = [];
  const upcoming = [];
  const finished = [];
  const top = [];

  for (const row of sorted) {
    const phase = resolveMatchPhase(row, now);
    if (isTopPick(row)) top.push(row);
    if (phase === "live") live.push(row);
    else if (phase === "finished") finished.push(row);
    else upcoming.push(row);
  }

  top.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));

  return { all: sorted, live, upcoming, finished, top };
}

module.exports = {
  parseKickoff,
  formatKickoffDisplay,
  formatKickoffTimeOnly,
  todayMatchDate,
  normalizeMatchDate,
  sortByKickoffAsc,
  resolveMatchPhase,
  isTopPick,
  partitionPredictions,
  kickoffSortKey,
};
