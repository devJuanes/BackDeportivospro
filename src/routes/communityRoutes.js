const express = require("express");
const {
  ensureSeed,
  listThreads,
  listReplies,
} = require("../controllers/communityController");

const router = express.Router();

router.get("/threads", listThreads);
router.get("/threads/:threadId/replies", listReplies);
router.post("/ensure-seed", ensureSeed);
router.get("/ensure-seed", ensureSeed);

module.exports = router;
