const express = require("express");
const {
  listVipPredictions,
  createVip,
  updateVipState,
  getVipDailySummary,
} = require("../controllers/vipController");

const router = express.Router();

router.get("/vip", listVipPredictions);
router.get("/vip/summary/today", getVipDailySummary);
router.post("/vip", createVip);
router.patch("/vip/:id/state", updateVipState);

module.exports = router;
