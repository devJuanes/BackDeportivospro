const express = require("express");
const { requireUser } = require("../utils/userAuth");
const ctrl = require("../controllers/notificationsController");

const router = express.Router();

router.post("/register", requireUser, ctrl.registerToken);
router.post("/unregister", requireUser, ctrl.unregisterToken);
router.get("/inbox", requireUser, ctrl.listInbox);
router.get("/prefs", requireUser, ctrl.getPrefs);
router.put("/prefs", requireUser, ctrl.putPrefs);

module.exports = router;
