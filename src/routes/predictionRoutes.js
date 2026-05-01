const express = require("express");
const {
  listFreePredictions,
  createPrediction,
  updateFreeState,
  updateFreeModeration,
  getFreeDailySummary,
} = require("../controllers/predictionController");

const router = express.Router();

router.get("/free", listFreePredictions);
router.get("/free/summary/today", getFreeDailySummary);
router.post("/free", createPrediction);
router.patch("/free/:id/state", updateFreeState);
router.patch("/free/:id/moderation", updateFreeModeration);

module.exports = router;
