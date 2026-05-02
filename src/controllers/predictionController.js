const {
  getFreePredictions,
  createFreePrediction,
  updateFreePredictionState,
  updateFreeModerationStatus,
  getFreeSummaryToday,
} = require("../models/predictionModel");
const { db } = require("../config/database");
const { sendMessage } = require("../config/whatsapp");

function buildWhatsappMessage(prediction) {
  return `⚽ PRONOSTICO DEL DIA

${prediction.home_team_name || prediction.team_a || prediction.homeTeam?.name} vs ${
    prediction.away_team_name || prediction.team_b || prediction.awayTeam?.name
  }

Pronostico:
${prediction.prediction || prediction.pick_text}

Confianza:
${prediction.confidence}%

Cuota:
${prediction.odds}

Resumen:
${prediction.rationale_short || "Consenso estadístico del día."}`;
}

async function listFreePredictions(req, res, next) {
  try {
    const rawLimit = Number.parseInt(String(req.query.limit || "100"), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(400, Math.max(1, rawLimit)) : 100;
    const rows = await getFreePredictions(limit, {
      todayOnly: req.query.today === "true",
      sport: req.query.sport,
      date: req.query.date,
      moderationStatus: req.query.moderation || "active",
    });
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

async function createPrediction(req, res, next) {
  try {
    const prediction = await createFreePrediction(req.body);
    const to = process.env.WHATSAPP_PHONE_FREE;
    if (to) {
      await sendMessage(to, buildWhatsappMessage(prediction));
    }
    res.status(201).json(prediction);
  } catch (error) {
    next(error);
  }
}

async function updateFreeState(req, res, next) {
  try {
    const row = await updateFreePredictionState(req.params.id, req.body.state);
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function updateFreeModeration(req, res, next) {
  try {
    const moderation = String(req.body.moderation_status || "").toLowerCase();
    if (!["pending", "active", "rejected"].includes(moderation)) {
      return res.status(400).json({ error: "moderation_status inválido" });
    }
    const row = await updateFreeModerationStatus(
      req.params.id,
      moderation,
      req.body.moderation_note || null
    );
    res.json(row);
  } catch (error) {
    next(error);
  }
}

async function getFreeDailySummary(req, res, next) {
  try {
    const summary = await getFreeSummaryToday();
    res.json(summary);
  } catch (error) {
    next(error);
  }
}

function slugToken(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSeoSlug(home, away, league) {
  const parts = [slugToken(home), "vs", slugToken(away), slugToken(league)].filter(Boolean);
  return parts.join("-") || "pronostico-del-partido";
}

function toSeoUrlRow(row) {
  const id = row?.id != null ? String(row.id) : "";
  if (!id) return null;
  const home = row.home_team_name || row.team_a || row.home_team || "local";
  const away = row.away_team_name || row.team_b || row.away_team || "visitante";
  const league = row.league || row.competition || "futbol";
  return {
    id,
    slug: buildSeoSlug(home, away, league),
    matchDate: row.match_date || null,
    updatedAt: row.updated_at || row.created_at || null,
  };
}

async function getSeoUrls(req, res, next) {
  try {
    const rawLimit = Number.parseInt(String(req.query.limit || ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 50), 2000) : 500;
    const out = new Map();

    const tables = ["abet", "abetvip", "free_picks", "vip_picks"];
    for (const table of tables) {
      const q = db
        .from(table)
        .select("id,league,home_team_name,away_team_name,team_a,team_b,match_date,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      const { data, error } = await q;
      if (error) continue;
      for (const row of data || []) {
        const mapped = toSeoUrlRow(row);
        if (!mapped) continue;
        if (!out.has(mapped.id)) out.set(mapped.id, mapped);
      }
    }

    const urls = [...out.values()].slice(0, limit);
    return res.json({
      total: urls.length,
      urls: urls.map((u) => ({
        path: `/pronosticos/${encodeURIComponent(u.id)}/${u.slug}`,
        lastmod: u.updatedAt || undefined,
        matchDate: u.matchDate || undefined,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listFreePredictions,
  createPrediction,
  updateFreeState,
  updateFreeModeration,
  getFreeDailySummary,
  getSeoUrls,
};
