const {
  ensureCommunitySeed,
  ensureMemberCount,
} = require("../services/communitySeedService");
const { db } = require("../config/database");

async function ensureSeed(req, res) {
  try {
    const result = await ensureCommunitySeed({
      maxNew: Number.parseInt(String(req.query.max || "12"), 10) || 12,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo sembrar la comunidad",
    });
  }
}

async function listThreads(req, res) {
  try {
    // No esperar al seed: listar ya y sembrar en background.
    void ensureCommunitySeed({ maxNew: 6 }).catch(() => {});
    const limit = Math.min(
      40,
      Number.parseInt(String(req.query.limit || "24"), 10) || 24,
    );
    const { data, error } = await db
      .from("pf_community_threads")
      .select(
        "id,title,body,user_name,prediction_id,sport,league,home_team,away_team,upvotes,reply_count,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    let members = 7240;
    try {
      members = await ensureMemberCount();
    } catch {
      /* keep default */
    }
    return res.json({
      ok: true,
      members,
      threads: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudieron listar hilos",
    });
  }
}

async function listReplies(req, res) {
  try {
    const threadId = String(req.params.threadId || "").trim();
    if (!threadId) {
      return res.status(400).json({ ok: false, error: "threadId requerido" });
    }
    const { data, error } = await db
      .from("pf_community_replies")
      .select("id,thread_id,user_name,body,created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(80);
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    return res.json({ ok: true, replies: data || [] });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudieron listar respuestas",
    });
  }
}

module.exports = {
  ensureSeed,
  listThreads,
  listReplies,
};
