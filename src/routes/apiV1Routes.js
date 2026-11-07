const express = require("express");
const ctrl = require("../controllers/apiV1Controller");
const teamsCtrl = require("../controllers/teamsController");

const router = express.Router();

router.get("/", ctrl.apiInfo);
router.get("/ai/status", ctrl.getAiStatus);
router.get("/predictions/summary/today", ctrl.getDailySummary);
router.post("/predictions/generate-today", ctrl.generateToday);
router.get("/predictions/followed", ctrl.listFollowed);
router.get("/predictions/:id", ctrl.getOnePrediction);
router.get("/predictions", ctrl.listPredictions);
router.post("/predictions/:id/follow", ctrl.postFollow);
router.delete("/predictions/:id/follow", ctrl.deleteFollow);
router.get("/news", ctrl.listNews);

/** Catalogo de equipos y ligas (indice local, sin I/O por request). */
router.get("/leagues", teamsCtrl.listLeaguesHandler);
router.get("/leagues/:slug", teamsCtrl.getLeagueHandler);
router.get("/teams/resolve", teamsCtrl.resolveTeamLogoHandler);
router.get("/teams", teamsCtrl.listTeamsHandler);
router.get("/teams/:slug", teamsCtrl.getTeamHandler);

module.exports = router;
