const express = require("express");
const {
  getWhatsappStatus,
  sendWhatsappTest,
} = require("../controllers/whatsappController");

const router = express.Router();

router.get("/status", getWhatsappStatus);
router.post("/test", sendWhatsappTest);

module.exports = router;
