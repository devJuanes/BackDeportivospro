/**
 * teamsService — indice unico de equipos y ligas.
 *
 * Fuente de verdad (local, sin I/O por request):
 *   data/futbool/ligas/<slug>.json   -> metadata de la liga + array `equipos`
 *   data/futbool/logos/<liga>/*.png  -> escudos servidos en /assets/leagues
 *
 * El JSON de cada liga trae por equipo: id, slug, nombre, nombreOficial, apodo,
 * abreviatura, fundacion, ciudad, estadio, capacidad, sitioWeb, logo, logoRemoto.
 *
 * Indices en memoria:
 *   byLeagueSlug : slug de liga          -> liga (con sus equipos)
 *   byTeamSlug   : slug de equipo        -> [equipos] (el slug puede repetirse entre ligas)
 *   byName       : nombre normalizado    -> [equipos] (match exacto)
 *   byToken      : token                  -> [equipos] (candidatos para busqueda/fuzzy)
 *
 * Cache e invalidacion:
 *   - TTL corto (TEAMS_INDEX_TTL_MS, default 30s) + firma de las carpetas.
 *   - POST /api/admin/futbool/reload fuerza el rebuild inmediato.
 *
 * Nota: `futboolLogoService` es un wrapper de este modulo (misma API publica).
 */

const fs = require("node:fs");
const path = require("node:path");

const DATA_ROOT = path.join(__dirname, "..", "..", "data", "futbool");
const LIGAS_DIR = path.join(DATA_ROOT, "ligas");
const LOGOS_DIR = path.join(DATA_ROOT, "logos");
/** Public mount for `data/futbool/logos` (see app.js). */
const LOGOS_PUBLIC_PREFIX = "/assets/leagues";
/** URL publica para logos en MatuDB (apps deben poder abrirla). */
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

/** Umbral minimo de score para aceptar un match difuso (mismo valor historico). */
const FUZZY_MIN_SCORE = 45;

const PLACEHOLDER_NAMES = new Set(["local", "visitante", "equipo local", "equipo visitante"]);

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
  return String(normalized || "")
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

/** Si ya viene una URL con localhost, la pasa a la base publica. */
function ensurePublicLogoUrl(url = "") {
  const s = String(url || "").trim();
  if (!s) return "";
  if (!isLocalhostUrl(s)) return s;
  const base = getPublicBaseUrl();
  return s
    .replace(/^https?:\/\/localhost(?::\d+)?/i, base)
    .replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?/i, base);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Lista recursiva de PNGs de logos: Set de rutas relativas a LOGOS_DIR. */
function listLogoFiles() {
  const files = new Set();
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (/\.png$/i.test(entry.name)) {
        files.add(rel);
      }
    }
  };
  walk(LOGOS_DIR, "");
  return files;
}

function listLeagueFiles() {
  try {
    return fs
      .readdirSync(LIGAS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/** Firma barata de las carpetas: cambia si se agregan/borran/actualizan archivos. */
function assetsSignature() {
  const files = listLeagueFiles();
  let maxJsonMtime = 0;
  for (const file of files) {
    try {
      const st = fs.statSync(path.join(LIGAS_DIR, file));
      if (st.mtimeMs > maxJsonMtime) maxJsonMtime = st.mtimeMs;
    } catch {
      /* archivo vanished entre readdir y stat */
    }
  }

  let maxLogoMtime = 0;
  let logoCount = 0;
  let logoDirs = [];
  try {
    logoDirs = fs
      .readdirSync(LOGOS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    /* sin logos */
  }
  for (const dir of logoDirs) {
    try {
      const st = fs.statSync(path.join(LOGOS_DIR, dir));
      if (st.mtimeMs > maxLogoMtime) maxLogoMtime = st.mtimeMs;
      logoCount += fs.readdirSync(path.join(LOGOS_DIR, dir)).length;
    } catch {
      /* dir vanished */
    }
  }

  return `${files.length}:${maxJsonMtime}:${maxLogoMtime}:${logoCount}`;
}

function leagueLogoRel(leagueSlug, logoFiles) {
  const candidates = [
    `${leagueSlug}/league.png`,
    `${leagueSlug}/_league.png`,
    `${leagueSlug}/${leagueSlug}.png`,
  ];
  for (const candidate of candidates) {
    if (logoFiles.has(candidate)) return candidate;
  }
  return "";
}

/**
 * URL definitiva del escudo (misma semantica historica):
 *   1) PNG local servido por la API publica
 *   2) logoRemoto solo si no hay PNG local
 *   3) URL publica esperada aunque el PNG falte en este entorno
 */
function computeLogoUrl(logoRel, logoRemoto, logoFiles) {
  const rel = String(logoRel || "").trim();
  if (rel && logoFiles.has(rel)) return publicUrlForRelPath(rel);
  const remote = String(logoRemoto || "").trim();
  if (/^https?:\/\//i.test(remote) && !isLocalhostUrl(remote)) return remote;
  if (rel) return publicUrlForRelPath(rel);
  return "";
}

function buildIndex(signature = assetsSignature()) {
  const startedAt = Date.now();
  const logoFiles = listLogoFiles();
  const teams = [];
  const leagues = [];
  const byLeagueSlug = new Map();
  const byTeamSlug = new Map();
  const byName = new Map();
  const byToken = new Map();

  const push = (map, key, value) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (const file of listLeagueFiles()) {
    const raw = readJsonSafe(path.join(LIGAS_DIR, file));
    if (!raw || typeof raw !== "object") continue;

    const leagueSlug = String(raw.slug || file.replace(/\.json$/i, "")).trim();
    const leagueName = String(raw.nombre || leagueSlug).trim();
    const logoRel = leagueLogoRel(leagueSlug, logoFiles);
    const league = {
      slug: leagueSlug,
      nombre: leagueName,
      pais: String(raw.pais || ""),
      temporada: String(raw.temporada || ""),
      fuente: String(raw.fuente || ""),
      actualizado: raw.actualizado || null,
      logoRel,
      logoUrl: logoRel ? publicUrlForRelPath(logoRel) : "",
      teams: [],
    };

    for (const eq of Array.isArray(raw.equipos) ? raw.equipos : []) {
      if (!eq || typeof eq !== "object") continue;
      const teamLogoRel = String(eq.logo || "")
        .replace(/^logos\//i, "")
        .replace(/\\/g, "/");
      const logoRemoto = String(eq.logoRemoto || eq.logo_remoto || "").trim();
      if (!teamLogoRel && !logoRemoto) continue;
      const hasLocal = Boolean(teamLogoRel) && logoFiles.has(teamLogoRel);
      if (teamLogoRel && !hasLocal && !/^https?:\/\//i.test(logoRemoto)) continue;

      const aliasSource = [
        eq.nombre,
        eq.nombreOficial,
        eq.apodo,
        eq.slug,
        eq.abreviatura,
      ].filter(Boolean);
      const names = [...new Set(aliasSource.map((n) => normalizeName(String(n).replace(/-/g, " "))).filter(Boolean))];
      const tokens = significantTokens(normalizeName(eq.nombre || eq.slug || ""));

      const team = {
        id: eq.id != null ? Number(eq.id) : null,
        slug: String(eq.slug || ""),
        leagueSlug,
        leagueName,
        leagueLogoUrl: league.logoUrl,
        nombre: String(eq.nombre || ""),
        nombreOficial: String(eq.nombreOficial || ""),
        apodo: String(eq.apodo || ""),
        abreviatura: String(eq.abreviatura || ""),
        fundacion: eq.fundacion != null ? Number(eq.fundacion) : null,
        ciudad: String(eq.ciudad || ""),
        estadio: String(eq.estadio || ""),
        capacidad: eq.capacidad != null ? Number(eq.capacidad) : null,
        sitioWeb: String(eq.sitioWeb || eq.sitio_web || ""),
        logoRel: teamLogoRel,
        logoRemoto,
        logoUrl: computeLogoUrl(teamLogoRel, logoRemoto, logoFiles),
        names,
        nameSet: new Set(names),
        tokens,
        tokenSet: new Set(tokens),
      };

      teams.push(team);
      league.teams.push(team);

      push(byTeamSlug, team.slug, team);
      for (const name of names) push(byName, name, team);

      // Indice de tokens (sin filtro de ruido) para candidatos de busqueda/fuzzy.
      for (const name of names) {
        for (const token of name.split(" ").filter(Boolean)) push(byToken, token, team);
      }
    }

    leagues.push(league);
    byLeagueSlug.set(leagueSlug, league);
  }

  const version = `${teams.length}:${leagues.length}:${signature}`;
  return {
    teams,
    leagues,
    byLeagueSlug,
    byTeamSlug,
    byName,
    byToken,
    nameKeys: [...byName.keys()],
    version,
    loadedAt: Date.now(),
    buildMs: Date.now() - startedAt,
    logoCount: logoFiles.size,
  };
}

let index = null;
let lastCheckedAt = 0;
let lastSignature = "";

function ttlMs() {
  const raw = Number.parseInt(String(process.env.TEAMS_INDEX_TTL_MS || ""), 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30_000;
}

function autoReloadEnabled() {
  const raw = String(process.env.TEAMS_INDEX_AUTO_RELOAD || "true").toLowerCase();
  return raw !== "false" && raw !== "0";
}

/** Indice vigente (rebuild si vencio el TTL y cambiaron los assets). */
function getIndex() {
  if (!index) return rebuildIndex();
  const ttl = ttlMs();
  const now = Date.now();
  if (!autoReloadEnabled() || now - lastCheckedAt < ttl) return index;
  lastCheckedAt = now;
  const signature = assetsSignature();
  if (signature !== lastSignature) rebuildIndex();
  return index;
}

function rebuildIndex() {
  const signature = assetsSignature();
  index = buildIndex(signature);
  lastCheckedAt = Date.now();
  lastSignature = signature;
  return index;
}

function getIndexVersion() {
  return getIndex().version;
}

function getStats() {
  const idx = getIndex();
  return {
    leagues: idx.leagues.length,
    teams: idx.teams.length,
    teamsWithLogo: idx.teams.length,
    logos: idx.logoCount,
    version: idx.version,
    loadedAt: new Date(idx.loadedAt).toISOString(),
    buildMs: idx.buildMs,
    ttlMs: ttlMs(),
    autoReload: autoReloadEnabled(),
    dataRoot: DATA_ROOT,
    publicPrefix: LOGOS_PUBLIC_PREFIX,
    publicBaseUrl: getPublicBaseUrl(),
  };
}

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

function toTeamDto(team) {
  if (!team) return null;
  return {
    id: team.id,
    slug: team.slug,
    leagueSlug: team.leagueSlug,
    leagueName: team.leagueName,
    leagueLogoUrl: team.leagueLogoUrl || "",
    nombre: team.nombre,
    nombreOficial: team.nombreOficial,
    apodo: team.apodo,
    abreviatura: team.abreviatura,
    fundacion: team.fundacion,
    ciudad: team.ciudad,
    estadio: team.estadio,
    capacidad: team.capacidad,
    sitioWeb: team.sitioWeb,
    logoUrl: team.logoUrl || "",
    logoRemoto: team.logoRemoto || "",
  };
}

function toLeagueDto(league, { includeTeams = false } = {}) {
  if (!league) return null;
  const dto = {
    slug: league.slug,
    nombre: league.nombre,
    pais: league.pais,
    temporada: league.temporada,
    logoUrl: league.logoUrl || "",
    teamCount: league.teams.length,
    actualizado: league.actualizado,
  };
  if (includeTeams) dto.teams = league.teams.map(toTeamDto);
  return dto;
}

/* ------------------------------------------------------------------ *
 * Busqueda
 * ------------------------------------------------------------------ */

function leagueHintMatches(team, leagueHintNorm) {
  if (!leagueHintNorm) return false;
  const leagueName = normalizeName(team.leagueName);
  const leagueSlug = normalizeName(String(team.leagueSlug || "").replace(/-/g, " "));
  return (
    leagueName.includes(leagueHintNorm) ||
    leagueHintNorm.includes(leagueName) ||
    leagueSlug.includes(leagueHintNorm) ||
    leagueHintNorm.includes(leagueSlug)
  );
}

/** Score difuso (misma formula historica, pero sin Set por llamada). */
function scoreTeamMatch(team, queryNorm, queryTokens, leagueHintNorm) {
  let score = 0;
  if (team.nameSet.has(queryNorm)) score += 100;
  for (const n of team.names) {
    if (n === queryNorm) continue;
    if (n.includes(queryNorm) || queryNorm.includes(n)) score += 40;
  }
  if (queryTokens.length && team.tokens.length) {
    let overlap = 0;
    for (const t of queryTokens) {
      if (team.tokenSet.has(t)) overlap += 1;
    }
    score += Math.round((overlap / Math.max(queryTokens.length, 1)) * 35);
  }
  if (leagueHintNorm && leagueHintMatches(team, leagueHintNorm)) score += 25;
  return score;
}

/** Candidatos rapidos: los que comparten al menos un token con la consulta. */
function candidateTeams(idx, queryTokens) {
  const out = new Set();
  for (const token of queryTokens) {
    const hits = idx.byToken.get(token);
    if (!hits) continue;
    for (const team of hits) out.add(team);
  }
  return out;
}

/**
 * Candidatos por contencion ("real madrid" dentro de "real madrid cf").
 * Recorre el indice de nombres (no los equipos) -> mucho mas barato que un
 * escaneo completo y equivalente: sin contencion, un equipo nunca pasa el
 * umbral (25 de liga no alcanzan 45).
 */
function containmentCandidates(idx, queryNorm) {
  const out = new Set();
  for (const key of idx.nameKeys) {
    if (key === queryNorm) continue;
    if (!key.includes(queryNorm) && !queryNorm.includes(key)) continue;
    const hits = idx.byName.get(key);
    if (!hits) continue;
    for (const team of hits) out.add(team);
  }
  return out;
}

/**
 * Resuelve el escudo de un equipo por nombre (match exacto -> difuso).
 * Mismo comportamiento que el servicio historico, pero con indice de tokens
 * para no recorrer los ~1.200 equipos en cada llamada.
 */
function resolveTeamLogoUrl(teamName, leagueHint = "") {
  const queryNorm = normalizeName(teamName);
  if (!queryNorm || PLACEHOLDER_NAMES.has(queryNorm)) return "";

  const idx = getIndex();
  const leagueHintNorm = normalizeName(leagueHint);
  const queryTokens = significantTokens(queryNorm);

  const exactHits = idx.byName.get(queryNorm) || [];
  if (exactHits.length === 1) return exactHits[0].logoUrl || "";
  if (exactHits.length > 1) {
    const preferred =
      exactHits.find((team) => leagueHintMatches(team, leagueHintNorm)) || exactHits[0];
    return preferred.logoUrl || "";
  }

  let best = null;
  let bestScore = 0;
  const candidates = candidateTeams(idx, queryTokens);
  for (const team of candidates) {
    const score = scoreTeamMatch(team, queryNorm, queryTokens, leagueHintNorm);
    if (score > bestScore) {
      bestScore = score;
      best = team;
    }
  }

  if (!best || bestScore < FUZZY_MIN_SCORE) {
    // Fallback por contencion (raro): mismo resultado que el escaneo total.
    for (const team of containmentCandidates(idx, queryNorm)) {
      if (candidates.has(team)) continue;
      const score = scoreTeamMatch(team, queryNorm, queryTokens, leagueHintNorm);
      if (score > bestScore) {
        bestScore = score;
        best = team;
      }
    }
  }

  if (!best || bestScore < FUZZY_MIN_SCORE) return "";
  return best.logoUrl || "";
}

/** URL del escudo de la liga (si existe `logos/<slug>/league.png`). */
function resolveLeagueLogoUrl(leagueNameOrSlug = "") {
  const hint = normalizeName(leagueNameOrSlug);
  if (!hint) return "";
  const idx = getIndex();
  const exact = findLeague(idx, leagueNameOrSlug);
  if (exact) return exact.logoUrl || "";

  for (const league of idx.leagues) {
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

/* ------------------------------------------------------------------ *
 * Consultas publicas (usadas por el controller)
 * ------------------------------------------------------------------ */

function rankByQuery(idx, pool, q) {
  const queryNorm = normalizeName(q);
  if (!queryNorm) return pool.slice();

  const poolSet = pool instanceof Set ? pool : new Set(pool);
  const scored = [];
  const seen = new Set();

  const exactHits = idx.byName.get(queryNorm) || [];
  for (const team of exactHits) {
    if (!poolSet.has(team) || seen.has(team)) continue;
    seen.add(team);
    scored.push({ team, score: 1000 });
  }

  for (const team of poolSet) {
    if (seen.has(team)) continue;
    for (const name of team.names) {
      if (name.startsWith(queryNorm)) {
        seen.add(team);
        scored.push({ team, score: 500 - Math.min(name.length, 99) });
        break;
      }
    }
  }

  const tokens = queryNorm.split(" ").filter(Boolean);
  for (const token of tokens) {
    const hits = idx.byToken.get(token);
    if (!hits) continue;
    for (const team of hits) {
      if (!poolSet.has(team) || seen.has(team)) continue;
      let score = 0;
      for (const name of team.names) {
        if (name.includes(queryNorm) || queryNorm.includes(name)) {
          score = Math.max(score, 300 - Math.min(Math.abs(name.length - queryNorm.length), 99));
          break;
        }
      }
      let overlap = 0;
      for (const t of tokens) {
        if (team.tokenSet.has(t)) overlap += 1;
      }
      score += overlap * 50;
      seen.add(team);
      scored.push({ team, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.team.nombre.localeCompare(b.team.nombre));
  return scored.map((s) => s.team);
}

/** Resuelve una liga por slug o por nombre (case/acento-insensitive). */
function findLeague(idx, key) {
  const raw = String(key || "").trim();
  if (!raw) return null;
  const bySlug = idx.byLeagueSlug.get(raw);
  if (bySlug) return bySlug;
  const norm = normalizeName(raw);
  const normSlug = normalizeName(raw.replace(/-/g, " "));
  return (
    idx.leagues.find(
      (l) =>
        normalizeName(l.nombre) === norm ||
        normalizeName(String(l.slug || "").replace(/-/g, " ")) === normSlug
    ) || null
  );
}

function listTeams({ league = "", q = "", limit = 50, offset = 0 } = {}) {
  const idx = getIndex();
  const leagueKey = String(league || "").trim();
  let pool = idx.teams;
  if (leagueKey) {
    const leagueEntry = findLeague(idx, leagueKey);
    pool = leagueEntry
      ? leagueEntry.teams
      : idx.teams.filter((t) => t.leagueSlug === leagueKey);
  }
  const filtered = q ? rankByQuery(idx, pool, q) : pool.slice();
  const total = filtered.length;
  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(1, Number(limit) || 50);
  return {
    items: filtered.slice(start, end).map(toTeamDto),
    total,
    offset: start,
    limit: Math.max(1, Number(limit) || 50),
  };
}

/** Devuelve la entrada cruda del indice (no DTO). Usar `toTeamDto` para la API. */
function getTeam(slug, league = "") {
  const idx = getIndex();
  const key = String(slug || "").trim();
  if (!key) return null;
  const hits = idx.byTeamSlug.get(key) || [];
  if (!hits.length) {
    const byName = idx.byName.get(normalizeName(key)) || [];
    if (!byName.length) return null;
    return pickByLeague(idx, byName, league) || byName[0];
  }
  return pickByLeague(idx, hits, league) || hits[0];
}

function pickByLeague(idx, hits, league = "") {
  const wanted = String(league || "").trim();
  if (!wanted) return null;
  const leagueEntry = findLeague(idx, wanted);
  if (leagueEntry) {
    const match = hits.find((t) => t.leagueSlug === leagueEntry.slug);
    if (match) return match;
  }
  return hits.find((t) => t.leagueSlug === wanted) || null;
}

function listLeagues({ q = "", limit = 50, offset = 0 } = {}) {
  const idx = getIndex();
  const queryNorm = normalizeName(q);
  let items = idx.leagues;
  if (queryNorm) {
    items = idx.leagues
      .map((league) => {
        let score = 0;
        const slugNorm = normalizeName(String(league.slug || "").replace(/-/g, " "));
        const nameNorm = normalizeName(league.nombre);
        if (nameNorm === queryNorm || slugNorm === queryNorm) score = 100;
        else if (nameNorm.startsWith(queryNorm) || slugNorm.startsWith(queryNorm)) score = 60;
        else if (nameNorm.includes(queryNorm) || slugNorm.includes(queryNorm)) score = 30;
        return { league, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.league.nombre.localeCompare(b.league.nombre))
      .map((entry) => entry.league);
  }
  const total = items.length;
  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(1, Number(limit) || 50);
  return {
    items: items.slice(start, end).map((league) => toLeagueDto(league)),
    total,
    offset: start,
    limit: Math.max(1, Number(limit) || 50),
  };
}

function getLeague(slug, { includeTeams = true } = {}) {
  const idx = getIndex();
  const key = String(slug || "").trim();
  if (!key) return null;
  const league = findLeague(idx, key);
  if (!league) return null;
  return toLeagueDto(league, { includeTeams });
}

/** Resuelve logos de un pick (home/away/league) sin sobrescribir los ya puestos. */
function pickTeamName(pick, side = "home") {
  if (side === "home") {
    return pick?.homeTeam?.name || pick?.home_team_name || pick?.home_team || pick?.team_a || "";
  }
  return pick?.awayTeam?.name || pick?.away_team_name || pick?.away_team || pick?.team_b || "";
}

/**
 * Fill empty home/away (and optional league) logo fields on a pick object.
 * Does not overwrite non-empty logos. Sets BOTH nested and flat fields.
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

module.exports = {
  // rutas / assets
  DATA_ROOT,
  LIGAS_DIR,
  LOGOS_DIR,
  LOGOS_PUBLIC_PREFIX,
  DEFAULT_PUBLIC_API,
  // helpers (compatibles con futboolLogoService)
  NOISE_TOKENS,
  FUZZY_MIN_SCORE,
  getPublicBaseUrl,
  ensurePublicLogoUrl,
  normalizeName,
  significantTokens,
  publicUrlForRelPath,
  // indice
  getIndex,
  getIndexVersion,
  getStats,
  rebuildIndex,
  listTeams,
  getTeam,
  listLeagues,
  getLeague,
  // logos
  resolveTeamLogoUrl,
  resolveLeagueLogoUrl,
  enrichPickLogos,
  pickTeamName,
  // dto
  toTeamDto,
  toLeagueDto,
};
