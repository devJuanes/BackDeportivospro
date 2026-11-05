const express = require("express");
const {
  createVipCheckout,
  confirmWompiReturn,
  wompiWebhook,
  getWompiStatus,
  getMyWompiRedemptions,
} = require("../controllers/wompiPaymentsController");
const {
  getLandapayStatus,
  createLandapayVipCheckout,
  confirmLandapayReturn,
} = require("../controllers/landapayPaymentsController");

const router = express.Router();

router.get("/wompi/status", getWompiStatus);
router.get("/wompi/my-redemptions", getMyWompiRedemptions);
router.post("/wompi/checkout", createVipCheckout);
router.post("/wompi/confirm-return", confirmWompiReturn);
router.post("/wompi/webhook", wompiWebhook);

router.get("/landapay/status", getLandapayStatus);
router.post("/landapay/checkout", createLandapayVipCheckout);
router.post("/landapay/confirm-return", confirmLandapayReturn);

/** Alias legacy → Landa Pay */
router.get("/paymatu/status", getLandapayStatus);
router.post("/paymatu/checkout", createLandapayVipCheckout);
router.post("/paymatu/confirm-return", confirmLandapayReturn);

module.exports = router;
