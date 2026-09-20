const express = require("express");
const {
  getStatus,
  runNow,
  publishNow,
  backfillNow,
  setPower,
  getSources,
  syncSources,
} = require("../controllers/factoryController");

const router = express.Router();

router.get("/status", getStatus);
router.post("/run-now", runNow);
router.post("/publish-now", publishNow);
router.post("/backfill-now", backfillNow);
router.post("/power", setPower);
router.get("/sources", getSources);
router.post("/sources/sync-default", syncSources);

module.exports = router;
