const express = require("express");
const {
  listLivePredictions,
  createLive,
} = require("../controllers/liveController");

const router = express.Router();

router.get("/live", listLivePredictions);
router.post("/live", createLive);

module.exports = router;
