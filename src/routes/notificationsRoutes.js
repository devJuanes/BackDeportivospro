const express = require("express");
const { requireUser } = require("../utils/userAuth");
const ctrl = require("../controllers/notificationsController");

const router = express.Router();

router.post("/register", requireUser, ctrl.registerToken);
router.post("/unregister", requireUser, ctrl.unregisterToken);

module.exports = router;
