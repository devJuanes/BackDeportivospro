const express = require("express");
const ctrl = require("../controllers/vipRequestController");
const { requireUser } = require("../utils/userAuth");

const router = express.Router();

router.post("/request", requireUser, ctrl.createRequest);
router.get("/request", requireUser, ctrl.getMyRequest);

module.exports = router;
