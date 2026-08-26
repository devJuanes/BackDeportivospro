const VALID_TIERS = ["free", "premium", "vip", "super", "top"];
const {
  resolveMatchPhase,
  isTopPick,
  parseKickoff,
  formatKickoffDisplay,
  normalizeMatchDate,
} = require("./matchSchedule");
const {
  resolveTeamLogoUrl,
  resolveLeagueLogoUrl,
} = require("../services/futboolLogoService");

function inferTier(payload, baseTier = "free") {
  const explicit = String(payload.tier || "").trim().toLowerCase();
  if (VALID_TIERS.includes(explicit)) return explicit;

  const conf = Number(payload.confidence) || 0;
  if (baseTier === "vip" || baseTier === "premium") {
    if (conf >= 92) return "top";
    if (conf >= 87) return "super";
    if (conf >= 80) return "premium";
    return "vip";
  }
  return "free";
}

function mapStatus(raw) {
  const s = String(raw || "pending").toLowerCase();
  if (s === "ganada" || s === "won") return "won";
  if (s === "perdida" || s === "lost") return "lost";
  if (s === "live" || s === "en_vivo") return "live";
  if (s === "void" || s === "anulada") return "void";
  return "pending";
}

function toPredictionJson(row, extra = {}) {
  if (!row) return null;
  const status = mapStatus(row.status);
  const matchPhase = resolveMatchPhase(row);
  const matchDate = normalizeMatchDate(row.match_date);
  const matchHour = row.match_hour ? String(row.match_hour).trim().slice(0, 5) : "00:00";
  const kickoff = parseKickoff(matchDate, matchHour);
  const homeTeam = row.home_team || row.team_a || row.home_team_name || "";
  const awayTeam = row.away_team || row.team_b || row.away_team_name || "";
  const league = row.league || "";
  const homeTeamLogo =
    row.home_team_logo || resolveTeamLogoUrl(homeTeam, league) || "";
  const awayTeamLogo =
    row.away_team_logo || resolveTeamLogoUrl(awayTeam, league) || "";
  const leagueLogo =
    row.league_logo || resolveLeagueLogoUrl(league) || "";
  return {
    id: row.id,
    tier: row.tier || "free",
    sport: row.sport || "football",
    league,
    leagueLogo,
    homeTeam,
    awayTeam,
    homeTeamLogo,
    awayTeamLogo,
    prediction: row.prediction || row.pick_text || "",
    odds: row.odds != null ? Number(row.odds) : 0,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    probability: row.probability != null ? Number(row.probability) : null,
    analysis: row.analysis || null,
    status,
    matchPhase,
    isFinished: matchPhase === "finished" || status === "won" || status === "lost",
    isLive: matchPhase === "live" || Boolean(row.is_live) || status === "live",
    isTop: isTopPick(row),
    matchDate,
    matchHour,
    kickoffAt: kickoff && !Number.isNaN(kickoff.getTime()) ? kickoff.toISOString() : null,
    kickoffDisplay: formatKickoffDisplay(matchDate, matchHour),
    score: {
      home: Number(row.home_goals) || 0,
      away: Number(row.away_goals) || 0,
      minute: Number(row.minute) || 0,
    },
    followCount: Number(row.follow_count) || 0,
    source: row.source || "factory",
    slug: row.slug || null,
    published: row.published !== false,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    ...extra,
  };
}

function toNewsJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug || null,
    title: row.title || "",
    summary: row.summary || row.excerpt || "",
    content: row.content || null,
    category: row.category || "noticias",
    image: row.image || row.image_url || "",
    url: row.url || null,
    source: row.source || row.author || "DeportivosPro",
    featured: Boolean(row.featured),
    publishedAt: row.published_at || row.created_at || null,
    createdAt: row.created_at || null,
  };
}

function apiOk(data, meta = {}) {
  return { ok: true, data, meta };
}

module.exports = {
  VALID_TIERS,
  inferTier,
  mapStatus,
  toPredictionJson,
  toNewsJson,
  apiOk,
};
