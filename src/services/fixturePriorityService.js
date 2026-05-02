const { clamp, formatDateInTimezone } = require("../utils/helpers");

const DEFAULT_PRIORITY_TERMS = [
  "libertadores",
  "champions",
  "premier",
  "la liga",
  "laliga",
  "uefa",
  "ucl",
  "serie a",
  "bundesliga",
  "ligue 1",
  "sudamericana",
  "europa league",
  "mundial",
  "copa",
  "betplay",
  "dimayor",
  "primera a",
  "colombia",
  "liga pro",
  "liga mx",
  "ecuador",
  "liga 1",
  "peru",
  "bolivia",
  "paraguay",
  "uruguay",
  "chile",
  "argentina",
  "brasileir",
  "atletico nacional",
  "millonarios",
  "america de cali",
  "junior",
  "deportivo cali",
  "once caldas",
];

function getPriorityTerms() {
  const raw = process.env.FACTORY_PRIORITY_TERMS;
  if (!raw) return DEFAULT_PRIORITY_TERMS;
  return raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function buildText(fixture) {
  return `${fixture.league || ""} ${fixture.homeTeam || ""} ${fixture.awayTeam || ""}`.toLowerCase();
}

function toHourNumber(hour = "00:00") {
  const [h, m] = String(hour).split(":");
  const hh = Number.parseInt(h || "0", 10);
  const mm = Number.parseInt(m || "0", 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return 0;
  return hh * 60 + mm;
}

function nowMinutesInFactoryTz(timeZone = "America/Bogota") {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const hh = Number.parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const mm = Number.parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return 0;
  return hh * 60 + mm;
}

function computePriorityScore(fixture, terms, calendarDayIso) {
  const text = buildText(fixture);
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 18;
  }
  const tz = process.env.FACTORY_TIMEZONE || "America/Bogota";
  if (
    calendarDayIso &&
    fixture.match_date === calendarDayIso &&
    fixture.status === "pre"
  ) {
    const kickMin = toHourNumber(fixture.match_hour || "00:00");
    const nowMin = nowMinutesInFactoryTz(tz);
    let deltaMin = kickMin - nowMin;
    if (deltaMin >= 0 && deltaMin <= 240) {
      score += Math.round((240 - deltaMin) / 8);
    }
  }
  const isLive = fixture.status === "in";
  if (isLive) score += 20;
  const goals = (fixture.homeGoals || 0) + (fixture.awayGoals || 0);
  score += clamp(goals, 0, 6);
  const minute = fixture.minute || 0;
  if (minute > 0) score += clamp(Math.floor(minute / 10), 0, 8);
  const hourWeight = Math.max(0, 1440 - toHourNumber(fixture.match_hour || "00:00")) / 240;
  score += Math.round(hourWeight);
  return score;
}

function prioritizeFixtures(fixtures = [], calendarDayIso = null) {
  const terms = getPriorityTerms();
  const dayIso =
    calendarDayIso ||
    formatDateInTimezone(new Date(), process.env.FACTORY_TIMEZONE || "America/Bogota");
  return [...fixtures]
    .map((fixture) => ({
      ...fixture,
      priority_score: computePriorityScore(fixture, terms, dayIso),
    }))
    .sort((a, b) => b.priority_score - a.priority_score);
}

/** PRNG determinista por semilla (baraja estable entre reinicios del proceso). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Baraja solo el tramo superior de la lista ya priorizada para que cada ciclo de fábrica
 * no procese siempre los mismos 6–10 partidos “top” (ej. mismo cruce europeo).
 */
function diversifyFixtures(fixtures, poolSize = 36, seed = 0) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return fixtures;
  }
  const n = Math.min(Math.max(1, poolSize), fixtures.length);
  const pool = fixtures.slice(0, n);
  const tail = fixtures.slice(n);
  const rng = mulberry32((seed >>> 0) || 1);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return [...pool, ...tail];
}

module.exports = {
  prioritizeFixtures,
  diversifyFixtures,
};
