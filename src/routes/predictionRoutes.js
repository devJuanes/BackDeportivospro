const express = require("express");
const {
  listFreePredictions,
  createPrediction,
  updateFreeState,
  updateFreeModeration,
  getFreeDailySummary,
  getSeoUrls,
  getSeoSitemapXml,
  getSeoSitemapPronosticosXml,
  getSeoSitemapLiveXml,
  getSeoSitemapBlogXml,
  getSeoSitemapIndexXml,
} = require("../controllers/predictionController");

const router = express.Router();

router.get("/free", listFreePredictions);
router.get("/free/summary/today", getFreeDailySummary);
router.get("/seo/urls", getSeoUrls);
router.get("/seo/sitemap.xml", getSeoSitemapXml);
router.get("/seo/sitemap-index.xml", getSeoSitemapIndexXml);
router.get("/seo/sitemap-pronosticos.xml", getSeoSitemapPronosticosXml);
router.get("/seo/sitemap-live.xml", getSeoSitemapLiveXml);
router.get("/seo/sitemap-blog.xml", getSeoSitemapBlogXml);
router.post("/free", createPrediction);
router.patch("/free/:id/state", updateFreeState);
router.patch("/free/:id/moderation", updateFreeModeration);

module.exports = router;
