const express = require("express");
const ctrl = require("../controllers/escaleraController");
const { requireUser } = require("../utils/userAuth");

const router = express.Router();

router.use(requireUser);

router.get("/sessions/active", ctrl.getActive);
router.get("/sessions/history", ctrl.getHistory);
router.post("/sessions/open", ctrl.openSession);
router.post("/sessions/:sessionId/close", ctrl.closeSession);

router.post("/steps/generate", ctrl.generateStep);
router.post("/steps/:stepId/accept", ctrl.acceptStep);
router.post("/steps/:stepId/reject", ctrl.rejectStep);
router.post("/steps/:stepId/resolve", ctrl.resolveStep);

router.post("/push/register", ctrl.registerPush);
router.post("/push/unregister", ctrl.unregisterPush);

module.exports = router;
