const { db } = require("../config/database");

function nowIso() {
  return new Date().toISOString();
}

async function loadPfUser(userId) {
  try {
    const { data, error } = await db
      .from("pf_users")
      .select("id,email,name,phone")
      .eq("id", userId)
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

async function findPending(userId) {
  const { data, error } = await db
    .from("vip_requests")
    .select("id,status,created_at,user_email,user_name")
    .eq("user_id", String(userId))
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * POST /api/vip/request
 * Body opcional: { message?, email?, name?, phone? }
 */
async function createRequest(req, res) {
  try {
    const userId = String(req.userId || "").trim();
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: "No autenticado",
      });
    }

    const pending = await findPending(userId);
    if (pending) {
      return res.status(409).json({
        ok: false,
        error: "already_pending",
        message: "Ya tienes una solicitud VIP pendiente",
        data: pending,
      });
    }

    const body = req.body || {};
    const pf = await loadPfUser(userId);
    const email =
      String(body.email || body.user_email || pf?.email || "").trim() || null;
    const name =
      String(body.name || body.user_name || pf?.name || "").trim() || null;
    const phone = String(body.phone || pf?.phone || "").trim() || null;
    const message = String(body.message || "").trim() || null;

    const row = {
      user_id: userId,
      user_email: email,
      user_name: name,
      phone,
      status: "pending",
      message,
      notes: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    const { data, error } = await db.from("vip_requests").insert(row);
    if (error) throw new Error(error.message);

    const created =
      Array.isArray(data) && data.length ? data[0] : data || row;

    return res.status(201).json({
      ok: true,
      message: "Solicitud VIP registrada",
      data: created,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "VipRequestError",
      message: e.message,
    });
  }
}

/**
 * GET /api/vip/request — estado de la solicitud del usuario autenticado
 */
async function getMyRequest(req, res) {
  try {
    const userId = String(req.userId || "").trim();
    const { data, error } = await db
      .from("vip_requests")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return res.json({ ok: true, data: data || null });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "VipRequestError",
      message: e.message,
    });
  }
}

module.exports = { createRequest, getMyRequest };
