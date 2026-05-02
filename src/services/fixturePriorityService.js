const { clamp } = require("../utils/helpers");

const DEFAULT_PRIORITY_TERMS = [
  "libertadores",
  "champions",
  "premier",
  "la liga",
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

function computePriorityScore(fixture, terms) {
  const text = buildText(fixture);
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 18;
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

function prioritizeFixtures(fixtures = []) {
  const terms = getPriorityTerms();
  return [...fixtures]
    .map((fixture) => ({
      ...fixture,
      priority_score: computePriorityScore(fixture, terms),
    }))
    .sort((a, b) => b.priority_score - a.priority_score);
}

module.exports = {
  prioritizeFixtures,
};
