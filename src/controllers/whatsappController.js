const { sendMessage, isWhatsAppReady } = require("../config/whatsapp");

async function getWhatsappStatus(req, res) {
  res.json({
    ready: isWhatsAppReady(),
  });
}

async function sendWhatsappTest(req, res, next) {
  try {
    const to = req.body.to || process.env.WHATSAPP_PHONE_FREE;
    const message = req.body.message || "Prueba DeportivosPro: bot operativo.";
    if (!to) {
      return res.status(400).json({ error: "Debes enviar 'to' o configurar WHATSAPP_PHONE_FREE" });
    }
    const sent = await sendMessage(to, message);
    if (!sent) {
      return res.status(503).json({ error: "WhatsApp no está ready" });
    }
    return res.json({ ok: true, to });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getWhatsappStatus,
  sendWhatsappTest,
};
