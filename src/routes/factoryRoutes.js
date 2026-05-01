const express = require("express");
const {
  getStatus,
  runNow,
  setPower,
  getSources,
  syncSources,
} = require("../controllers/factoryController");

const router = express.Router();

router.get("/status", getStatus);
router.post("/run-now", runNow);
router.post("/power", setPower);
router.get("/sources", getSources);
router.post("/sources/sync-default", syncSources);

module.exports = router;
