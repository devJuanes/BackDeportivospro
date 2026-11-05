/**
 * Admin MatuPicks — VIP, tips settle, factory, modales in-app.
 * Auth: isAdminHttpRequest (JWT + pf_users.is_admin / ADMIN_EMAILS).
 */
const { db } = require("../config/database");
const { isAdminHttpRequest } = require("../utils/adminHttpAuth");
const { setFactoryEnabled, getFactoryStatus, runFactoryCycleNow, setAutoSettleEnabled } = require("../services/factoryService");
const { preserveSettledOutcome } = require("../utils/preserveSettledOutcome");

function nowIso() {
  return new Date().toISOString();
}

async function requireAdmin(req, res) {
  if (!(await isAdminHttpRequest(req))) {
    res.status(403).json({
      ok: false,
      error: "forbidden",
      message: "Se requiere administrador (pf_users.is_admin o ADMIN_EMAILS).",
    });
    return false;
  }
  return true;
}

function plantTable(tier) {
  const t = String(tier || "free").toLowerCase();
  if (t === "vip" || t === "premium") return "abetvip";
  if (t === "live") return "abetlive";
  return "abet";
}

/** GET /api/admin/me */
async function me(req, res) {
  try {
    const ok = await isAdminHttpRequest(req);
    return res.json({ ok: true, isAdmin: ok });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** GET /api/admin/vip-requests?status=pending */
async function listVipRequests(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const status = String(req.query.status || "").trim().toLowerCase();
    let q = db.from("vip_requests").select("*").order("created_at", { ascending: false }).limit(200);
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      q = q.eq("status", status);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return res.json({ ok: true, data: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/**
 * POST /api/admin/vip-requests/:id/decide
 * body: { action: 'approve'|'reject', notes?, vip_days? }
 */
async function decideVipRequest(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const id = String(req.params.id || "").trim();
    const action = String(req.body?.action || "").toLowerCase();
    const notes = String(req.body?.notes || "").trim() || null;
    const vipDays = Math.max(1, Number(req.body?.vip_days) || 30);

    if (!id || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ ok: false, message: "action debe ser approve|reject" });
    }

    const { data: rows, error: rErr } = await db.from("vip_requests").select("*").eq("id", id).limit(1);
    if (rErr) throw new Error(rErr.message);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(404).json({ ok: false, message: "Solicitud no encontrada" });

    const status = action === "approve" ? "approved" : "rejected";
    const { error: uErr } = await db
      .from("vip_requests")
      .eq("id", id)
      .update({ status, notes, updated_at: nowIso() });
    if (uErr) throw new Error(uErr.message);

    if (action === "approve" && row.user_id) {
      const expires = new Date(Date.now() + vipDays * 24 * 60 * 60 * 1000).toISOString();
      const { error: pErr } = await db
        .from("pf_users")
        .eq("id", row.user_id)
        .update({
          is_vip: true,
          vip_expires_at: expires,
          updated_at: nowIso(),
        });
      if (pErr) {
        // fallback by email
        if (row.user_email) {
          await db
            .from("pf_users")
            .eq("email", row.user_email)
            .update({ is_vip: true, vip_expires_at: expires, updated_at: nowIso() });
        }
      }
    }

    return res.json({ ok: true, status, id });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** GET /api/admin/users?q= */
async function listUsers(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const q = String(req.query.q || "").trim().toLowerCase();
    let query = db
      .from("pf_users")
      .select("id,name,email,phone,is_vip,vip_expires_at,is_admin,is_active,created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    let rows = data || [];
    if (q) {
      rows = rows.filter(
        (u) =>
          String(u.email || "").toLowerCase().includes(q) ||
          String(u.name || "").toLowerCase().includes(q)
      );
    }
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** PATCH /api/admin/users/:id  body: { is_vip?, vip_days?, is_admin?, is_active? } */
async function patchUser(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const id = String(req.params.id || "").trim();
    const body = req.body || {};
    const patch = { updated_at: nowIso() };
    if (typeof body.is_vip === "boolean") {
      patch.is_vip = body.is_vip;
      if (body.is_vip) {
        const days = Math.max(1, Number(body.vip_days) || 30);
        patch.vip_expires_at = new Date(Date.now() + days * 86400000).toISOString();
      } else if (body.clear_expiry) {
        patch.vip_expires_at = null;
      }
    }
    if (typeof body.is_admin === "boolean") patch.is_admin = body.is_admin;
    if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
    const { error } = await db.from("pf_users").eq("id", id).update(patch);
    if (error) throw new Error(error.message);
    return res.json({ ok: true, id, patch });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/**
 * POST /api/admin/tips/settle
 * body: { tier: 'free'|'vip'|'live', id, state: 'won'|'lost'|'pending'|'live', live_ended?, home_goals?, away_goals?, minute? }
 */
async function settleTip(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tier = String(req.body?.tier || "free").toLowerCase();
    const id = String(req.body?.id || "").trim();
    const stateIn = String(req.body?.state || "").toLowerCase();
    if (!id || !["won", "lost", "pending", "live", "void", "ended"].includes(stateIn)) {
      return res.status(400).json({ ok: false, message: "id y state (won|lost|pending|live|void|ended) requeridos" });
    }
    const table = plantTable(tier);
    const { data: curRows } = await db.from(table).select("*").eq("id", id).limit(1);
    const current = Array.isArray(curRows) ? curRows[0] : curRows;
    if (!current) return res.status(404).json({ ok: false, message: "Tip no encontrado" });

    const preserved = preserveSettledOutcome(current, stateIn, stateIn);
    // Admin puede forzar: si pide won/lost explícito, respetar (override)
    const force = ["won", "lost", "void"].includes(stateIn);
    const finalState = force ? stateIn : preserved.state;
    const finalOutcome = force ? stateIn : preserved.outcome;

    const patch = {
      updated_at: nowIso(),
      state: finalState === "ended" ? "ended" : finalState,
    };
    if (tier === "live") {
      patch.outcome = finalOutcome;
      if (typeof req.body.live_ended === "boolean") {
        patch.live_ended = req.body.live_ended;
      } else if (["won", "lost", "void", "ended", "pending"].includes(stateIn) && stateIn !== "live") {
        patch.live_ended = true;
      }
      if (stateIn === "live") {
        patch.live_ended = false;
        patch.state = "live";
        if (!force) patch.outcome = current.outcome || null;
      }
    }
    if (req.body.home_goals != null) patch.home_goals = Number(req.body.home_goals) || 0;
    if (req.body.away_goals != null) patch.away_goals = Number(req.body.away_goals) || 0;
    if (req.body.minute != null) patch.minute = Number(req.body.minute) || 0;

    const { error } = await db.from(table).eq("id", id).update(patch);
    if (error) throw new Error(error.message);
    return res.json({ ok: true, table, id, patch });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/**
 * POST /api/admin/tips
 * body: { tier, home_team_name, away_team_name, prediction, odds?, confidence?, sport?, league?, match_date?, match_hour?, analysis? }
 */
async function createTip(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tier = String(req.body?.tier || "free").toLowerCase();
    const table = plantTable(tier);
    const home = String(req.body?.home_team_name || "").trim();
    const away = String(req.body?.away_team_name || "").trim();
    const prediction = String(req.body?.prediction || "").trim();
    if (!home || !away || !prediction) {
      return res.status(400).json({ ok: false, message: "home_team_name, away_team_name y prediction requeridos" });
    }
    const today = new Date().toISOString().slice(0, 10);
    const row = {
      sport: String(req.body?.sport || "football").toLowerCase(),
      league: String(req.body?.league || "").trim() || "Manual",
      home_team_name: home,
      away_team_name: away,
      home_team_logo: String(req.body?.home_team_logo || ""),
      away_team_logo: String(req.body?.away_team_logo || ""),
      prediction,
      odds: Number(req.body?.odds) || null,
      confidence: Number(req.body?.confidence) || null,
      match_date: String(req.body?.match_date || today).slice(0, 10),
      match_hour: String(req.body?.match_hour || "00:00").slice(0, 5),
      state: tier === "live" ? "live" : "pending",
      home_goals: 0,
      away_goals: 0,
      minute: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (tier === "live") {
      row.outcome = null;
      row.live_ended = false;
      row.ai_rationale = String(req.body?.analysis || "").trim() || null;
    } else if (req.body?.analysis) {
      row.analysis = String(req.body.analysis);
    }

    const { data, error } = await db.from(table).insert(row);
    if (error) throw new Error(error.message);
    const created = Array.isArray(data) ? data[0] : data;
    return res.status(201).json({ ok: true, data: created || row, table });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** PATCH /api/admin/tips/:tier/:id */
async function updateTip(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const tier = String(req.params.tier || "free").toLowerCase();
    const id = String(req.params.id || "").trim();
    const table = plantTable(tier);
    const body = req.body || {};
    const allowed = [
      "home_team_name",
      "away_team_name",
      "prediction",
      "odds",
      "confidence",
      "sport",
      "league",
      "match_date",
      "match_hour",
      "analysis",
      "ai_rationale",
      "home_goals",
      "away_goals",
      "minute",
      "home_team_logo",
      "away_team_logo",
    ];
    const patch = { updated_at: nowIso() };
    for (const k of allowed) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    const { error } = await db.from(table).eq("id", id).update(patch);
    if (error) throw new Error(error.message);
    return res.json({ ok: true, table, id, patch });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** Factory */
async function factoryStatus(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const status = await getFactoryStatus();
    return res.json({ ok: true, ...status });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

async function factoryPower(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const enabled = req.body?.enabled === true;
    const state = setFactoryEnabled(enabled);
    return res.json({ ok: true, ...state });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** Pausar/activar liquidación automática (ganado/perdido por API). */
async function settlePower(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const enabled = req.body?.enabled === true;
    const state = setAutoSettleEnabled(enabled);
    return res.json({ ok: true, ...state });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

async function factoryRun(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const result = await runFactoryCycleNow({ includeNews: true });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** Modals CRUD */
async function listModals(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { data, error } = await db
      .from("app_modal_campaigns")
      .select("*")
      .order("priority", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return res.json({ ok: true, data: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

async function upsertModal(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const body = req.body || {};
    const id = body.id ? String(body.id) : null;
    const row = {
      image_url: String(body.image_url || ""),
      title: String(body.title || ""),
      body: String(body.body || ""),
      cta_label: String(body.cta_label || ""),
      cta_url: String(body.cta_url || ""),
      cta_route: String(body.cta_route || ""),
      active: body.active === true,
      starts_at: body.starts_at || null,
      ends_at: body.ends_at || null,
      priority: Number(body.priority) || 0,
      updated_at: nowIso(),
    };
    if (id) {
      const { error } = await db.from("app_modal_campaigns").eq("id", id).update(row);
      if (error) throw new Error(error.message);
      return res.json({ ok: true, id, ...row });
    }
    row.created_at = nowIso();
    const { data, error } = await db.from("app_modal_campaigns").insert(row);
    if (error) throw new Error(error.message);
    return res.status(201).json({ ok: true, data: Array.isArray(data) ? data[0] : data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

async function deleteModal(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const id = String(req.params.id || "").trim();
    const { error } = await db.from("app_modal_campaigns").eq("id", id).delete();
    if (error) throw new Error(error.message);
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** Public active modal for app (no admin) */
async function activeModalPublic(req, res) {
  try {
    const now = nowIso();
    const { data, error } = await db
      .from("app_modal_campaigns")
      .select("*")
      .eq("active", true)
      .order("priority", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    const rows = (data || []).filter((m) => {
      if (m.starts_at && String(m.starts_at) > now) return false;
      if (m.ends_at && String(m.ends_at) < now) return false;
      return true;
    });
    return res.json({ ok: true, data: rows[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

/** News admin helpers via MatuDB plant */
async function createNews(req, res) {
  try {
    if (!(await requireAdmin(req, res))) return;
    const body = req.body || {};
    const row = {
      title: String(body.title || "").trim(),
      summary: String(body.summary || body.excerpt || "").trim(),
      content: String(body.content || "").trim(),
      url: String(body.url || "").trim(),
      image: String(body.image || body.image_url || "").trim(),
      source: String(body.source || "admin"),
      slug: String(body.slug || "").trim() || null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!row.title) return res.status(400).json({ ok: false, message: "title requerido" });
    const { data, error } = await db.from("sports_news").insert(row);
    if (error) throw new Error(error.message);
    return res.status(201).json({ ok: true, data: Array.isArray(data) ? data[0] : data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

module.exports = {
  me,
  listVipRequests,
  decideVipRequest,
  listUsers,
  patchUser,
  settleTip,
  createTip,
  updateTip,
  factoryStatus,
  factoryPower,
  settlePower,
  factoryRun,
  listModals,
  upsertModal,
  deleteModal,
  activeModalPublic,
  createNews,
};
