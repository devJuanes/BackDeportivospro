const express = require("express");
const ctrl = require("../controllers/authTrialController");
const firebaseCtrl = require("../controllers/authFirebaseController");

const router = express.Router();

router.post("/send-verification-code", ctrl.postSendCode);
router.post("/verify-code", ctrl.postVerifyCode);
router.post("/claim-vip-trial", ctrl.postClaimTrial);

router.post("/firebase/sync", firebaseCtrl.postFirebaseSync);
router.get("/firebase/me", firebaseCtrl.getFirebaseMe);

module.exports = router;
