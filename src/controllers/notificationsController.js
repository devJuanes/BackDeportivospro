const escalera = require("../services/escaleraService");

async function registerToken(req, res) {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "token requerido" });
    const row = await escalera.registerPushToken(req.userId, token, req.body?.device_info || {});
    return res.status(201).json({ token: row });
  } catch (e) {
    return res.status(e.status || 500).json({ error: "NotificationsError", message: e.message });
  }
}

async function unregisterToken(req, res) {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "token requerido" });
    const out = await escalera.unregisterPushToken(req.userId, token);
    return res.json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: "NotificationsError", message: e.message });
  }
}

module.exports = { registerToken, unregisterToken };
