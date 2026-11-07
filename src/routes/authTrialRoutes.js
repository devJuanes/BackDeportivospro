const express = require("express");
const ctrl = require("../controllers/authTrialController");
const firebaseCtrl = require("../controllers/authFirebaseController");

const router = express.Router();

router.get("/email-verification", ctrl.getEmailVerification);
router.post("/send-verification-code", ctrl.postSendCode);
router.post("/verify-code", ctrl.postVerifyCode);
router.post("/claim-vip-trial", ctrl.postClaimTrial);

router.post("/password/forgot", ctrl.postPasswordForgot);
router.post("/password/verify-code", ctrl.postPasswordVerifyCode);
router.post("/password/confirm", ctrl.postPasswordConfirm);

router.get("/google/status", ctrl.getGoogleOauthStatus);
router.post("/google/token", ctrl.postGoogleToken);

router.post("/firebase/sync", firebaseCtrl.postFirebaseSync);
router.get("/firebase/me", firebaseCtrl.getFirebaseMe);

module.exports = router;
