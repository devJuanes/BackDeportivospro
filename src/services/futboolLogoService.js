const fs = require("node:fs");
const path = require("node:path");

const DATA_ROOT = path.join(__dirname, "..", "..", "data", "futbool");
const LIGAS_DIR = path.join(DATA_ROOT, "ligas");
const LOGOS_DIR = path.join(DATA_ROOT, "logos");
/** Public mount for `data/futbool/logos` (see app.js). */
const LOGOS_PUBLIC_PREFIX = "/assets/leagues";
/** URL pública para logos en MatuDB (apps deben poder abrirla). */
const DEFAULT_PUBLIC_API = "https://api.picks.matupicks.app";

const NOISE_TOKENS = new Set([
  "fc",
  "cf",
  "cd",
  "sc",
  "ac",
  "as",
  "afc",
  "club",
  "deportivo",
  "deportiva",
  "atletico",
  "atletica",
  "athletic",
  "sporting",
  "united",
  "city",
  "real",
  "the",
  "de",
  "la",
  "el",
  "los",
  "las",
  "del",
]);

let cache = null;

function isLocalhostUrl(url = "") {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(String(url).trim());
}

/**
 * Base URL absoluta para logos guardados en BD.
 * Nunca usa localhost salvo FORCE_LOCAL_LOGO_URLS=true.
 */
function getPublicBaseUrl() {
  const forceLocal = String(process.env.FORCE_LOCAL_LOGO_URLS || "").toLowerCase() === "true";
  const fromEnv = String(
    process.env.LOGO_PUBLIC_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.API_PUBLIC_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");

  if (fromEnv && (!isLocalhostUrl(fromEnv) || forceLocal)) {
    return fromEnv;
  }
  return DEFAULT_PUBLIC_API;
}

function normalizeName(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(normalized = "") {
  return normalized
    .split(" ")
    .filter((t) => t.length > 1 && !NOISE_TOKENS.has(t));
}

function publicUrlForRelPath(relFromLogos = "") {
  const cleaned = String(relFromLogos || "")
    .replace(/^logos\//i, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  if (!cleaned) return "";
  return `${getPublicBaseUrl()}${LOGOS_PUBLIC_PREFIX}/${cleaned}`;
}

/** Si ya viene una URL con localhost, la pasa a la base pública. */
function ensurePublicLogoUrl(url = "") {
  const s = String(url || "").trim();
  if (!s) return "";
  if (!isLocalhostUrl(s)) return s;
  const base = getPublicBaseUrl();
  return s
    .replace(/^https?:\/\/localhost(?::\d+)?/i, base)
    .replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?/i, base);
}

function loadCache() {
  if (cache) return cache;

  const teams = [];
  const leagues = [];
  const byExact = new Map();
  const byLeagueSlug = new Map();

  if (!fs.existsSync(LIGAS_DIR)) {
    cache = { teams, leagues, byExact, byLeagueSlug, loadedAt: Date.now() };
    return cache;
  }

  const files = fs.readdirSync(LIGAS_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(LIGAS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const leagueSlug = String(data.slug || file.replace(/\.json$/i, "")).trim();
    const leagueName = String(data.nombre || leagueSlug).trim();
    const leagueNorm = normalizeName(leagueName);
    const leagueSlugNorm = normalizeName(leagueSlug.replace(/-/g, " "));

    const leagueLogoCandidates = [
      path.join(LOGOS_DIR, leagueSlug, "league.png"),
      path.join(LOGOS_DIR, leagueSlug, "_league.png"),
      path.join(LOGOS_DIR, leagueSlug, `${leagueSlug}.png`),
    ];
    let leagueLogoRel = "";
    for (const candidate of leagueLogoCandidates) {
      if (fs.existsSync(candidate)) {
        leagueLogoRel = path
          .relative(LOGOS_DIR, candidate)
          .replace(/\\/g, "/");
        break;
      }
    }

    const leagueEntry = {
      slug: leagueSlug,
      nombre: leagueName,
      pais: data.pais || "",
      logoRel: leagueLogoRel,
      logoUrl: leagueLogoRel ? publicUrlForRelPath(leagueLogoRel) : "",
    };
    leagues.push(leagueEntry);
    byLeagueSlug.set(leagueSlug, leagueEntry);

    for (const eq of data.equipos || []) {
      const logoRel = String(eq.logo || "")
        .replace(/^logos\//i, "")
        .replace(/\\/g, "/");
      const logoRemoto = String(eq.logoRemoto || eq.logo_remoto || "").trim();
      if (!logoRel && !logoRemoto) continue;
      if (logoRel) {
        const abs = path.join(LOGOS_DIR, logoRel);
        // Si no hay PNG local pero sí URL remota, igual indexamos el equipo.
        if (!fs.existsSync(abs) && !/^https?:\/\//i.test(logoRemoto)) continue;
      }

      const names = [
        eq.nombre,
        eq.nombreOficial,
        eq.apodo,
        eq.slug,
        eq.abreviatura,
      ]
        .filter(Boolean)
        .map((n) => normalizeName(String(n).replace(/-/g, " ")))
        .filter(Boolean);

      const entry = {
        id: eq.id,
        slug: eq.slug,
        nombre: eq.nombre || "",
        nombreOficial: eq.nombreOficial || "",
        leagueSlug,
        leagueName,
        logoRel,
        logoRemoto,
        names: [...new Set(names)],
        tokens: significantTokens(normalizeName(eq.nombre || eq.slug || "")),
      };
      teams.push(entry);

      for (const n of entry.names) {
        if (!byExact.has(n)) byExact.set(n, []);
        byExact.get(n).push(entry);
      }
    }
  }

  cache = { teams, leagues, byExact, byLeagueSlug, loadedAt: Date.now() };
  return cache;
}

function leagueHintMatches(entry, leagueHintNorm) {
  if (!leagueHintNorm) return false;
  const leagueName = normalizeName(entry.leagueName);
  const leagueSlug = normalizeName(String(entry.leagueSlug || "").replace(/-/g, " "));
  return (
    leagueName.includes(leagueHintNorm) ||
    leagueHintNorm.includes(leagueName) ||
    leagueSlug.includes(leagueHintNorm) ||
    leagueHintNorm.includes(leagueSlug)
  );
}

function scoreTeamMatch(entry, queryNorm, queryTokens, leagueHintNorm) {
  let score = 0;
  if (entry.names.includes(queryNorm)) score += 100;
  for (const n of entry.names) {
    if (n === queryNorm) continue;
    if (n.includes(queryNorm) || queryNorm.includes(n)) score += 40;
  }

  if (queryTokens.length && entry.tokens.length) {
    const entrySet = new Set(entry.tokens);
    let overlap = 0;
    for (const t of queryTokens) {
      if (entrySet.has(t)) overlap += 1;
    }
    score += Math.round((overlap / Math.max(queryTokens.length, 1)) * 35);
  }

  if (leagueHintNorm && leagueHintMatches(entry, leagueHintNorm)) {
    score += 25;
  }

  return score;
}

/**
 * URL a persistir en MatuDB:
 * 1) Logo local servido por la API pública (api.picks.matupicks.app/assets/leagues/...)
 * 2) Fallback logoRemoto solo si no hay PNG en disco
 * Nunca localhost.
 */
function absoluteLogoForEntry(entry) {
  const rel = String(entry?.logoRel || "").trim();
  if (rel) {
    const abs = path.join(LOGOS_DIR, rel);
    if (fs.existsSync(abs)) {
      return publicUrlForRelPath(rel);
    }
  }
  const remote = String(entry?.logoRemoto || "").trim();
  if (/^https?:\/\//i.test(remote) && !isLocalhostUrl(remote)) {
    return remote;
  }
  // Sin archivo local: igual devolvemos la URL pública esperada (el PNG puede
  // existir en el server aunque falte en este entorno).
  if (rel) return publicUrlForRelPath(rel);
  return "";
}

/**
 * Resolve a team logo public URL from local futbool assets.
 * Guarda siempre la URL pública del API cuando hay logo local.
 * @param {string} teamName
 * @param {string} [leagueHint]
 * @returns {string} absolute URL or ""
 */
function resolveTeamLogoUrl(teamName, leagueHint = "") {
  const queryNorm = normalizeName(teamName);
  if (!queryNorm || queryNorm === "local" || queryNorm === "visitante" || queryNorm === "equipo local" || queryNorm === "equipo visitante") {
    return "";
  }

  const { byExact, teams } = loadCache();
  const leagueHintNorm = normalizeName(leagueHint);
  const queryTokens = significantTokens(queryNorm);

  const exactHits = byExact.get(queryNorm) || [];
  if (exactHits.length === 1) {
    return absoluteLogoForEntry(exactHits[0]);
  }
  if (exactHits.length > 1) {
    const preferred =
      exactHits.find((e) => leagueHintMatches(e, leagueHintNorm)) || exactHits[0];
    return absoluteLogoForEntry(preferred);
  }

  let best = null;
  let bestScore = 0;
  for (const entry of teams) {
    const score = scoreTeamMatch(entry, queryNorm, queryTokens, leagueHintNorm);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  // Require a reasonably confident fuzzy hit.
  if (!best || bestScore < 45) return "";
  return absoluteLogoForEntry(best);
}

/**
 * Optional league badge URL when `logos/<slug>/league.png` (or similar) exists.
 */
function resolveLeagueLogoUrl(leagueNameOrSlug = "") {
  const hint = normalizeName(leagueNameOrSlug);
  if (!hint) return "";
  const { leagues } = loadCache();
  for (const league of leagues) {
    const name = normalizeName(league.nombre);
    const slug = normalizeName(String(league.slug || "").replace(/-/g, " "));
    if (
      name === hint ||
      slug === hint ||
      name.includes(hint) ||
      hint.includes(name) ||
      slug.includes(hint) ||
      hint.includes(slug)
    ) {
      return league.logoUrl || "";
    }
  }
  return "";
}

function pickTeamName(pick, side = "home") {
  if (side === "home") {
    return (
      pick?.homeTeam?.name ||
      pick?.home_team_name ||
      pick?.home_team ||
      pick?.team_a ||
      ""
    );
  }
  return (
    pick?.awayTeam?.name ||
    pick?.away_team_name ||
    pick?.away_team ||
    pick?.team_b ||
    ""
  );
}

/**
 * Fill empty home/away (and optional league) logo fields on a pick object.
 * Does not overwrite non-empty logos. Sets BOTH nested and flat fields so
 * plant publish (abet/abetvip/abetlive) always persists URLs when resolved.
 */
function enrichPickLogos(pick) {
  if (!pick || typeof pick !== "object") return pick;

  const league = pick.league || "";
  const homeName = pickTeamName(pick, "home");
  const awayName = pickTeamName(pick, "away");

  const resolvedHome = resolveTeamLogoUrl(homeName, league);
  const resolvedAway = resolveTeamLogoUrl(awayName, league);
  const resolvedLeague = resolveLeagueLogoUrl(league);

  if (pick.homeTeam && typeof pick.homeTeam === "object") {
    if (!pick.homeTeam.logo && resolvedHome) pick.homeTeam.logo = resolvedHome;
    else if (pick.homeTeam.logo) pick.homeTeam.logo = ensurePublicLogoUrl(pick.homeTeam.logo);
  }
  if (!pick.home_team_logo) {
    pick.home_team_logo = pick.homeTeam?.logo || resolvedHome || "";
  } else {
    pick.home_team_logo = ensurePublicLogoUrl(pick.home_team_logo);
  }

  if (pick.awayTeam && typeof pick.awayTeam === "object") {
    if (!pick.awayTeam.logo && resolvedAway) pick.awayTeam.logo = resolvedAway;
    else if (pick.awayTeam.logo) pick.awayTeam.logo = ensurePublicLogoUrl(pick.awayTeam.logo);
  }
  if (!pick.away_team_logo) {
    pick.away_team_logo = pick.awayTeam?.logo || resolvedAway || "";
  } else {
    pick.away_team_logo = ensurePublicLogoUrl(pick.away_team_logo);
  }

  if (!pick.league_logo && resolvedLeague) {
    pick.league_logo = resolvedLeague;
  } else if (pick.league_logo) {
    pick.league_logo = ensurePublicLogoUrl(pick.league_logo);
  }

  return pick;
}

function getLogoStats() {
  const { teams, leagues } = loadCache();
  return {
    leagues: leagues.length,
    teamsWithLogo: teams.length,
    dataRoot: DATA_ROOT,
    publicPrefix: LOGOS_PUBLIC_PREFIX,
    publicBaseUrl: getPublicBaseUrl(),
  };
}

function reloadLogoCache() {
  cache = null;
  return loadCache();
}

module.exports = {
  DATA_ROOT,
  LOGOS_DIR,
  LOGOS_PUBLIC_PREFIX,
  DEFAULT_PUBLIC_API,
  getPublicBaseUrl,
  ensurePublicLogoUrl,
  normalizeName,
  publicUrlForRelPath,
  resolveTeamLogoUrl,
  resolveLeagueLogoUrl,
  enrichPickLogos,
  getLogoStats,
  reloadLogoCache,
};
