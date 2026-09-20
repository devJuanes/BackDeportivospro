const {
  getPredictions,
  getPredictionById,
  getSummaryToday,
  followPrediction,
  unfollowPrediction,
  getFollowedPredictions,
} = require("../models/dpPredictionModel");
const { getNews } = require("../models/newsModel");
const { getSportsNews } = require("../models/sportsNewsModel");
const { toPredictionJson, toNewsJson, apiOk, VALID_TIERS } = require("../utils/predictionDto");
const { runFactoryCycleNow } = require("../services/factoryService");
const { partitionPredictions, todayMatchDate } = require("../utils/matchSchedule");

function buildPredictionsPayload(rows, extraMeta = {}) {
  const parts = partitionPredictions(rows);
  const mapRow = (r) => toPredictionJson(r);
  return {
    data: parts.all.map(mapRow),
    sections: {
      live: parts.live.map(mapRow),
      top: parts.top.map(mapRow),
      upcoming: parts.upcoming.map(mapRow),
      finished: parts.finished.map(mapRow),
    },
    meta: {
      total: parts.all.length,
      sortedBy: "kickoff_asc",
      live: parts.live.length,
      top: parts.top.length,
      upcoming: parts.upcoming.length,
      finished: parts.finished.length,
      ...extraMeta,
    },
  };
}

function parseLimit(raw, fallback = 100, max = 400) {
  const n = Number.parseInt(String(raw || fallback), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : fallback;
}

async function listPredictions(req, res, next) {
  try {
    const tier = req.query.tier ? String(req.query.tier).trim().toLowerCase() : null;
    if (tier && !VALID_TIERS.includes(tier)) {
      return res.status(400).json({ ok: false, error: `tier inválido. Usa: ${VALID_TIERS.join(", ")}` });
    }

    const limit = parseLimit(req.query.limit);
    const showAll = req.query.all === "true" || req.query.today === "false";
    const dateFilter = req.query.date ? String(req.query.date).slice(0, 10) : todayMatchDate();
    const rows = await getPredictions(limit, {
      tier,
      todayOnly: !showAll,
      date: showAll && req.query.date ? dateFilter : dateFilter,
      sport: req.query.sport,
      status: req.query.status,
    });

    const payload = buildPredictionsPayload(rows, {
      tier: tier || "all",
      date: showAll && !req.query.date ? "all" : dateFilter,
      timezone: process.env.FACTORY_TIMEZONE || "America/Bogota",
    });
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return next(error);
  }
}

async function getOnePrediction(req, res, next) {
  try {
    const row = await getPredictionById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "Pronóstico no encontrado" });
    return res.json(apiOk(toPredictionJson(row)));
  } catch (error) {
    return next(error);
  }
}

async function getDailySummary(req, res, next) {
  try {
    const tier = req.query.tier ? String(req.query.tier).trim().toLowerCase() : null;
    const summary = await getSummaryToday(tier);
    return res.json(apiOk(summary, { tier: tier || "all" }));
  } catch (error) {
    return next(error);
  }
}

async function postFollow(req, res, next) {
  try {
    const clientId = String(req.body.client_id || req.query.client_id || "").trim();
    if (!clientId) {
      return res.status(400).json({ ok: false, error: "client_id requerido" });
    }
    const pred = await getPredictionById(req.params.id);
    if (!pred) return res.status(404).json({ ok: false, error: "Pronóstico no encontrado" });

    const result = await followPrediction(req.params.id, clientId);
    return res.status(result.already ? 200 : 201).json(
      apiOk({ predictionId: req.params.id, clientId, ...result })
    );
  } catch (error) {
    return next(error);
  }
}

async function deleteFollow(req, res, next) {
  try {
    const clientId = String(req.body.client_id || req.query.client_id || "").trim();
    if (!clientId) {
      return res.status(400).json({ ok: false, error: "client_id requerido" });
    }
    await unfollowPrediction(req.params.id, clientId);
    return res.json(apiOk({ predictionId: req.params.id, clientId, unfollowed: true }));
  } catch (error) {
    return next(error);
  }
}

async function listFollowed(req, res, next) {
  try {
    const clientId = String(req.query.client_id || "").trim();
    if (!clientId) {
      return res.status(400).json({ ok: false, error: "client_id requerido" });
    }
    const limit = parseLimit(req.query.limit, 50, 200);
    const rows = await getFollowedPredictions(clientId, limit);
    const payload = buildPredictionsPayload(rows, { clientId, followed: true });
    return res.json({ ok: true, ...payload });
  } catch (error) {
    return next(error);
  }
}

async function listNews(req, res, next) {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    let rows = [];
    try {
      rows = await getSportsNews(limit);
    } catch {
      rows = await getNews(limit);
    }
    return res.json(apiOk(rows.map(toNewsJson), { total: rows.length }));
  } catch (error) {
    return next(error);
  }
}

async function generateToday(req, res, next) {
  try {
    const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
    const demoKey = String(process.env.DEMO_FACTORY_KEY || "").trim();
    const headerKey = String(req.get("x-demo-key") || "").trim();
    if (isProd && demoKey && headerKey !== demoKey) {
      return res.status(403).json({ ok: false, error: "Clave demo inválida (X-Demo-Key)" });
    }

    const date = todayMatchDate();
    const factory = await runFactoryCycleNow({
      matchDate: date,
      latamFootballOnly: false,
      includeNews: false,
    });
    const rows = await getPredictions(200, { todayOnly: true, date });
    const payload = buildPredictionsPayload(rows, {
      date,
      generated: true,
      fixtures_found: factory.last_run_result?.pipeline?.by_sport?.[0]?.fixtures_total ?? rows.length,
      factory: factory.skipped
        ? { skipped: true, reason: factory.reason }
        : { free: factory.last_run_result?.pipeline?.free || 0, vip: factory.last_run_result?.pipeline?.vip || 0 },
    });

    return res.json({ ok: true, ...payload });
  } catch (error) {
    return next(error);
  }
}

async function apiInfo(req, res) {
  return res.json({
    ok: true,
    service: "DeportivosPro API",
    version: "v1",
    endpoints: {
      predictions: "/api/v1/predictions (por defecto solo hoy; ?all=true para histórico)",
      generateToday: "POST /api/v1/predictions/generate-today",
      prediction: "/api/v1/predictions/:id",
      summary: "/api/v1/predictions/summary/today",
      follow: "POST /api/v1/predictions/:id/follow",
      unfollow: "DELETE /api/v1/predictions/:id/follow",
      followed: "/api/v1/predictions/followed?client_id=...",
      news: "/api/v1/news",
      health: "/health",
      demo: "/demo",
    },
    tiers: VALID_TIERS,
  });
}

module.exports = {
  apiInfo,
  listPredictions,
  getOnePrediction,
  getDailySummary,
  postFollow,
  deleteFollow,
  listFollowed,
  listNews,
  generateToday,
};
