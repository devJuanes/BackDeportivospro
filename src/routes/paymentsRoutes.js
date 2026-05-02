const express = require("express");
const {
  createVipCheckout,
  confirmWompiReturn,
  wompiWebhook,
  getWompiStatus,
  getMyWompiRedemptions,
} = require("../controllers/wompiPaymentsController");

const router = express.Router();

router.get("/wompi/status", getWompiStatus);
router.get("/wompi/my-redemptions", getMyWompiRedemptions);
router.post("/wompi/checkout", createVipCheckout);
router.post("/wompi/confirm-return", confirmWompiReturn);
router.post("/wompi/webhook", wompiWebhook);

module.exports = router;
