/**
 * teamsController — API publica de equipos y ligas.
 *
 * Sin I/O por request: todo sale del indice en memoria de `teamsService`.
 * Optimizaciones:
 *   - cuerpo JSON serializado y cacheado por (version del indice + query)
 *   - ETag debil + Cache-Control => el movil recibe 304 sin body
 *   - paginacion por limit/offset (sin traer el catalogo completo)
 *
 * Ver src/docs/teams-api.md
 */

const {
  getIndexVersion,
  listTeams,
  getTeam,
  listLeagues,
  getLeague,
  toTeamDto,
} = require("../services/teamsService");
const { apiOk } = require("../utils/predictionDto");

const MAX_CACHE_ENTRIES = 256;

function parseLimit(raw, fallback = 50, max = 500) {
  const n = Number.parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

function parseOffset(raw) {
  const n = Number.parseInt(String(raw ?? 0), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function cacheMaxAgeSeconds() {
  const n = Number.parseInt(String(process.env.TEAMS_API_CACHE_MAX_AGE || ""), 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return 300;
}

/** Hash FNV-1a (barato) para el ETag. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const bodyCache = new Map();

/**
 * Devuelve el body serializado (cacheado por version + key).
 * `build` responde { status, payload }.
 * El cache se invalida solo cuando cambia la version del indice.
 */
function cachedBody(key, build) {
  const version = getIndexVersion();
  const cacheKey = `${version}|${key}`;
  const hit = bodyCache.get(cacheKey);
  if (hit) return hit;

  const { status = 200, payload } = build();
  const body = JSON.stringify(payload);
  const entry = {
    body,
    status,
    etag: `W/"${hashString(`${cacheKey}|${body.length}`)}"`,
  };

  if (bodyCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = bodyCache.keys().next().value;
    bodyCache.delete(oldest);
  }
  bodyCache.set(cacheKey, entry);
  return entry;
}

function sendCached(req, res, key, build) {
  const { body, etag, status } = cachedBody(key, build);
  res.set("ETag", etag);
  res.set("Cache-Control", `public, max-age=${cacheMaxAgeSeconds()}`);
  res.set("X-Index-Version", getIndexVersion());

  const inm = String(req.get("if-none-match") || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (inm.length && (inm.includes(etag) || inm.includes("*"))) {
    return res.status(304).end();
  }
  return res.status(status).type("application/json").send(body);
}

/** GET /api/v1/leagues?q=&limit=&offset= */
async function listLeaguesHandler(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit, 50, 500);
    const offset = parseOffset(req.query.offset);
    const q = String(req.query.q || req.query.search || "").trim();
    const key = `leagues|${q.toLowerCase()}|${limit}|${offset}`;
    return sendCached(req, res, key, () => {
      const { items, total } = listLeagues({ q, limit, offset });
      return {
        status: 200,
        payload: apiOk(items, {
          total,
          count: items.length,
          limit,
          offset,
          q: q || null,
        }),
      };
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/v1/leagues/:slug  (incluye los equipos de la liga) */
async function getLeagueHandler(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    const includeTeams = req.query.teams !== "false";
    const key = `league|${slug}|${includeTeams}`;
    return sendCached(req, res, key, () => {
      const league = getLeague(slug, { includeTeams });
      if (!league) {
        return {
          status: 404,
          payload: { ok: false, error: "Liga no encontrada", meta: { slug } },
        };
      }
      return {
        status: 200,
        payload: apiOk(league, {
          slug,
          teamCount: league.teamCount,
        }),
      };
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/v1/teams?league=&q=&limit=&offset= */
async function listTeamsHandler(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit, 50, 500);
    const offset = parseOffset(req.query.offset);
    const league = String(req.query.league || "").trim();
    const q = String(req.query.q || req.query.search || "").trim();
    const key = `teams|${league}|${q.toLowerCase()}|${limit}|${offset}`;
    return sendCached(req, res, key, () => {
      const { items, total } = listTeams({ league, q, limit, offset });
      return {
        status: 200,
        payload: apiOk(items, {
          total,
          count: items.length,
          limit,
          offset,
          league: league || "all",
          q: q || null,
        }),
      };
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/v1/teams/:slug?league= */
async function getTeamHandler(req, res, next) {
  try {
    const slug = String(req.params.slug || "").trim();
    const league = String(req.query.league || "").trim();
    const key = `team|${slug}|${league}`;
    return sendCached(req, res, key, () => {
      const team = getTeam(slug, league);
      if (!team) {
        return {
          status: 404,
          payload: { ok: false, error: "Equipo no encontrado", meta: { slug } },
        };
      }
      return {
        status: 200,
        payload: apiOk(toTeamDto(team), { slug, league: team.leagueSlug }),
      };
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/v1/teams/resolve?name=&league= — escudo por nombre (para MatuDB / front). */
async function resolveTeamLogoHandler(req, res, next) {
  try {
    const {
      resolveTeamLogoUrl,
      resolveLeagueLogoUrl,
    } = require("../services/teamsService");
    const name = String(req.query.name || req.query.q || "").trim();
    const league = String(req.query.league || "").trim();
    if (!name) {
      return res.status(400).json({ ok: false, error: "name requerido" });
    }
    const logoUrl = resolveTeamLogoUrl(name, league) || "";
    const leagueLogo = league ? resolveLeagueLogoUrl(league) || "" : "";
    return res.json({
      ok: true,
      data: {
        name,
        league: league || null,
        logoUrl,
        leagueLogo: leagueLogo || null,
      },
    });
  } catch (error) {
    return next(error);
  }
}

/** Limpia el cache de bodies (lo llama el reload admin). */
function clearBodyCache() {
  bodyCache.clear();
}

module.exports = {
  listLeaguesHandler,
  getLeagueHandler,
  listTeamsHandler,
  getTeamHandler,
  resolveTeamLogoHandler,
  clearBodyCache,
};
