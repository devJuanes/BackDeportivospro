/**
 * Filters fixtures / tips so the factory prefers real upcoming events
 * and drops empty, finished, or garbage markets.
 */

const PLACEHOLDER_TEAMS = new Set([
  "local",
  "visitante",
  "home",
  "away",
  "tbd",
  "tba",
  "n/a",
  "na",
  "unknown",
  "equipo local",
  "equipo visitante",
]);

const GARBAGE_PICK_PATTERNS = [
  /^n\/?a$/i,
  /^-+$/i,
  /^tbd$/i,
  /^test\b/i,
  /^lorem\b/i,
  /placeholder/i,
  /ejemplo/i,
  /^sin tip/i,
  /^pendiente$/i,
];

function normalizeTeamName(name = "") {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isPlaceholderTeam(name = "") {
  const n = normalizeTeamName(name);
  if (!n || n.length < 2) return true;
  return PLACEHOLDER_TEAMS.has(n);
}

/** Partido usable para tips pre-partido: equipos reales, no finalizado. */
function isUsableUpcomingFixture(fixture = {}) {
  const home = fixture.homeTeam || fixture.home_team_name || "";
  const away = fixture.awayTeam || fixture.away_team_name || "";
  if (isPlaceholderTeam(home) || isPlaceholderTeam(away)) return false;
  if (normalizeTeamName(home) === normalizeTeamName(away)) return false;

  const status = String(fixture.status || "pre").toLowerCase();
  if (status === "post" || status === "final" || status === "closed") return false;

  const date = String(fixture.match_date || fixture.date || "").slice(0, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  return true;
}

/** Prefer pre-match; keep live only when explicitly allowed. */
function filterFixturesForTips(fixtures = [], opts = {}) {
  const allowLive = opts.allowLive === true;
  return (fixtures || []).filter((f) => {
    if (!isUsableUpcomingFixture(f)) return false;
    const status = String(f.status || "pre").toLowerCase();
    if (status === "in" || status === "live") return allowLive;
    return status === "pre" || status === "" || status === "scheduled";
  });
}

function isGarbagePickLabel(pick = "") {
  const s = String(pick || "").trim();
  if (!s || s.length < 4) return true;
  if (s.length > 120) return true;
  return GARBAGE_PICK_PATTERNS.some((re) => re.test(s));
}

/**
 * Quality gate after AI/rules: drop spammy low-confidence or empty tips.
 * Env: FACTORY_MIN_CONFIDENCE_FREE (default 60), FACTORY_MIN_CONFIDENCE_VIP (default 70)
 */
function passesQualityGate(record, tier = "free") {
  if (!record) return false;
  const pick = record.prediction || record.pick || "";
  if (isGarbagePickLabel(pick)) return false;

  const home = record.homeTeam?.name || record.home_team_name || "";
  const away = record.awayTeam?.name || record.away_team_name || "";
  if (isPlaceholderTeam(home) || isPlaceholderTeam(away)) return false;

  const conf = Number(record.confidence);
  const minFree = Number.parseInt(process.env.FACTORY_MIN_CONFIDENCE_FREE || "60", 10);
  const minVip = Number.parseInt(process.env.FACTORY_MIN_CONFIDENCE_VIP || "70", 10);
  const min = tier === "vip" ? minVip : minFree;
  if (!Number.isFinite(conf) || conf < min) return false;

  return true;
}

function filterQualityPicks(picks = [], tier = "free") {
  return (picks || []).filter((p) => passesQualityGate(p, tier));
}

module.exports = {
  isUsableUpcomingFixture,
  filterFixturesForTips,
  isGarbagePickLabel,
  passesQualityGate,
  filterQualityPicks,
};
