const express = require("express");
const {
  createVipCheckout,
  confirmWompiReturn,
  wompiWebhook,
  getWompiStatus,
} = require("../controllers/wompiPaymentsController");

const router = express.Router();

router.get("/wompi/status", getWompiStatus);
router.post("/wompi/checkout", createVipCheckout);
router.post("/wompi/confirm-return", confirmWompiReturn);
router.post("/wompi/webhook", wompiWebhook);

module.exports = router;
