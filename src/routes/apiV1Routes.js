const express = require("express");
const ctrl = require("../controllers/apiV1Controller");

const router = express.Router();

router.get("/", ctrl.apiInfo);
router.get("/predictions/summary/today", ctrl.getDailySummary);
router.post("/predictions/generate-today", ctrl.generateToday);
router.get("/predictions/followed", ctrl.listFollowed);
router.get("/predictions/:id", ctrl.getOnePrediction);
router.get("/predictions", ctrl.listPredictions);
router.post("/predictions/:id/follow", ctrl.postFollow);
router.delete("/predictions/:id/follow", ctrl.deleteFollow);
router.get("/news", ctrl.listNews);

module.exports = router;
