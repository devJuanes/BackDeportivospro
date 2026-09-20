const escalera = require("../services/escaleraService");
const { db } = require("../config/database");

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

async function getPrefs(req, res) {
  try {
    const { data, error } = await db
      .from("pf_notification_prefs")
      .select("*")
      .eq("user_id", req.userId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return res.json({
      ok: true,
      data: data || {
        user_id: req.userId,
        notif_live: true,
        notif_free: true,
        notif_vip: true,
        notif_news: false,
        notif_followed: true,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: "NotificationsError", message: e.message });
  }
}

async function putPrefs(req, res) {
  try {
    const body = req.body || {};
    const row = {
      user_id: req.userId,
      notif_live: body.notif_live !== false && body.live !== false,
      notif_free: body.notif_free !== false && body.free !== false,
      notif_vip: body.notif_vip !== false && body.vip !== false,
      notif_news: body.notif_news === true || body.news === true,
      notif_followed: body.notif_followed !== false && body.followed !== false,
      updated_at: new Date().toISOString(),
    };
    // Normalizar si vienen explícitos en false
    if (body.notif_live === false || body.live === false) row.notif_live = false;
    if (body.notif_free === false || body.free === false) row.notif_free = false;
    if (body.notif_vip === false || body.vip === false) row.notif_vip = false;
    if (body.notif_followed === false || body.followed === false) row.notif_followed = false;

    const { error } = await db.from("pf_notification_prefs").upsert(row, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return res.json({ ok: true, data: row });
  } catch (e) {
    return res.status(500).json({ error: "NotificationsError", message: e.message });
  }
}

module.exports = { registerToken, unregisterToken, getPrefs, putPrefs };
