const { isAdminBearer } = require("../utils/jwtAdmin");
const {
  generatePreviaBlogsForDate,
  generateRecapBlogsOnce,
  todayIsoDate,
} = require("../services/blogGenerationService");

function blogCronAuthorized(req) {
  const secret = String(process.env.BLOG_CRON_SECRET || "").trim();
  if (!secret) return false;
  const h = String(req.get("x-blog-cron-secret") || req.query.secret || "").trim();
  return h === secret;
}

async function postGeneratePrevias(req, res, next) {
  try {
    if (!isAdminBearer(req.get("authorization")) && !blogCronAuthorized(req)) {
      return res.status(403).json({
        error: "forbidden",
        message: "JWT admin o x-blog-cron-secret requerido.",
      });
    }
    const raw =
      (req.body && req.body.match_date) ||
      (typeof req.query?.match_date === "string" && req.query.match_date) ||
      "";
    const matchDate = String(raw).trim();
    const day = matchDate && /^\d{4}-\d{2}-\d{2}$/.test(matchDate) ? matchDate : todayIsoDate();
    const maxArticles = Math.min(
      8,
      Math.max(1, Number.parseInt(String(req.body?.max ?? req.query?.max ?? "4"), 10) || 4),
    );
    const result = await generatePreviaBlogsForDate(day, maxArticles);
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
}

async function postGenerateRecaps(req, res, next) {
  try {
    if (!isAdminBearer(req.get("authorization")) && !blogCronAuthorized(req)) {
      return res.status(403).json({
        error: "forbidden",
        message: "JWT admin o x-blog-cron-secret requerido.",
      });
    }
    const maxPicks = Math.min(
      6,
      Math.max(1, Number.parseInt(String(req.body?.max ?? req.query?.max ?? "3"), 10) || 3),
    );
    const result = await generateRecapBlogsOnce(maxPicks);
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  postGeneratePrevias,
  postGenerateRecaps,
};
