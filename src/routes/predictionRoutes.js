const express = require("express");
const {
  listFreePredictions,
  createPrediction,
  updateFreeState,
  updateFreeModeration,
  getFreeDailySummary,
  getSeoUrls,
} = require("../controllers/predictionController");

const router = express.Router();

router.get("/free", listFreePredictions);
router.get("/free/summary/today", getFreeDailySummary);
router.get("/seo/urls", getSeoUrls);
router.post("/free", createPrediction);
router.patch("/free/:id/state", updateFreeState);
router.patch("/free/:id/moderation", updateFreeModeration);

module.exports = router;
