/**
 * Push FCM respetando preferencias y follows.
 * Tokens: notification_tokens (+ fallback pf_users.fcm_token / project_push_tokens).
 */
const logger = require("../utils/logger");
const { db } = require("../config/database");
const { sendPushToTokens } = require("./firebasePushService");
const { scrubPlayStoreText } = require("../utils/playStoreSafe");

function pushEnabled() {
  return String(process.env.PREDICTION_PUSH_ENABLED || "true").toLowerCase() !== "false";
}

async function loadPrefsByUserIds(userIds = []) {
  const map = new Map();
  if (!userIds.length) return map;
  try {
    const { data, error } = await db
      .from("pf_notification_prefs")
      .select("user_id,notif_live,notif_free,notif_vip,notif_news,notif_followed")
      .in("user_id", userIds)
      .limit(Math.min(800, userIds.length + 10));
    if (error) return map;
    for (const row of data || []) {
      map.set(String(row.user_id), {
        live: row.notif_live !== false,
        free: row.notif_free !== false,
        vip: row.notif_vip !== false,
        news: row.notif_news === true,
        followed: row.notif_followed !== false,
      });
    }
  } catch {
    /* ignore */
  }
  return map;
}

/** default prefs if user never saved */
function defaultPrefs() {
  return { live: true, free: true, vip: true, news: false, followed: true };
}

async function listTokensForPref(prefKey, limit = 500) {
  const tokens = new Set();
  const userIds = [];

  // 1) notification_tokens (registro oficial)
  try {
    const { data, error } = await db
      .from("notification_tokens")
      .select("user_id,token")
      .eq("app_id", "matupicks")
      .limit(limit);
    if (!error) {
      for (const row of data || []) {
        if (row.user_id) userIds.push(String(row.user_id));
        if (row.token) tokens.add(String(row.token).trim());
      }
    }
  } catch {
    /* ignore */
  }

  // 2) pf_users.fcm_token
  try {
    const { data, error } = await db
      .from("pf_users")
      .select("id,fcm_token")
      .not("fcm_token", "is", null)
      .limit(limit);
    if (!error) {
      for (const row of data || []) {
        if (row.id) userIds.push(String(row.id));
        if (row.fcm_token) tokens.add(String(row.fcm_token).trim());
      }
    }
  } catch {
    /* columna puede no existir aún */
  }

  // Filtrar por preferencia
  const prefs = await loadPrefsByUserIds([...new Set(userIds)]);
  const allowedUsers = new Set();
  for (const uid of [...new Set(userIds)]) {
    const p = prefs.get(uid) || defaultPrefs();
    if (p[prefKey]) allowedUsers.add(uid);
  }

  // Reconstruir tokens solo de usuarios con pref activa
  const filtered = new Set();
  try {
    const { data } = await db
      .from("notification_tokens")
      .select("user_id,token")
      .eq("app_id", "matupicks")
      .limit(limit);
    for (const row of data || []) {
      if (allowedUsers.has(String(row.user_id)) && row.token) {
        filtered.add(String(row.token).trim());
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const { data } = await db
      .from("pf_users")
      .select("id,fcm_token")
      .not("fcm_token", "is", null)
      .limit(limit);
    for (const row of data || []) {
      if (allowedUsers.has(String(row.id)) && row.fcm_token) {
        filtered.add(String(row.fcm_token).trim());
      }
    }
  } catch {
    /* ignore */
  }

  // Si no hay prefs/users aún, no spamear con tablas legacy globales
  // (solo tokens ligados a usuario con pref).
  if (filtered.size > 0) return [...filtered];

  // Bootstrap: si nadie tiene prefs, enviar a todos los tokens registrados (primera fase).
  if (tokens.size > 0 && prefs.size === 0) return [...tokens];
  return [...filtered];
}

async function listTokensForUserIds(userIds = [], requireFollowedPref = true) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const prefs = await loadPrefsByUserIds(ids);
  const allowed = ids.filter((uid) => {
    const p = prefs.get(uid) || defaultPrefs();
    return requireFollowedPref ? p.followed !== false : true;
  });
  if (!allowed.length) return [];

  const out = new Set();
  try {
    const { data } = await db
      .from("notification_tokens")
      .select("user_id,token")
      .in("user_id", allowed)
      .eq("app_id", "matupicks")
      .limit(500);
    for (const row of data || []) {
      if (row.token) out.add(String(row.token).trim());
    }
  } catch {
    /* ignore */
  }
  try {
    const { data } = await db
      .from("pf_users")
      .select("id,fcm_token")
      .in("id", allowed)
      .limit(500);
    for (const row of data || []) {
      if (row.fcm_token) out.add(String(row.fcm_token).trim());
    }
  } catch {
    /* ignore */
  }
  return [...out];
}

async function sendToTokens(tokens, { title, body, data = {} }) {
  if (!pushEnabled()) return { sentCount: 0, skipped: true };
  const clean = (tokens || []).filter(Boolean);
  if (!clean.length) return { sentCount: 0, reason: "no_tokens" };
  try {
    return await sendPushToTokens({
      tokens: clean,
      title: scrubPlayStoreText(title),
      body: scrubPlayStoreText(body),
      data,
      channelId: "matupicks_tips",
    });
  } catch (error) {
    logger.warn(`[push] ${error.message}`);
    return { sentCount: 0, error: error.message };
  }
}

async function notifyNewPublishedPick(row, tier = "free") {
  const prefKey = tier === "vip" ? "vip" : "free";
  const tokens = await listTokensForPref(prefKey);
  const home = row.home_team_name || row.homeTeam?.name || "Local";
  const away = row.away_team_name || row.awayTeam?.name || "Visitante";
  return sendToTokens(tokens, {
    title: tier === "vip" ? "Nuevo tip VIP" : "Nuevo tip del día",
    body: `${home} vs ${away} · ${row.prediction || ""}`.slice(0, 180),
    data: {
      type: "new_pick",
      tier: String(tier),
      prediction_id: String(row.id || ""),
    },
  });
}

async function notifyLivePick(row) {
  const minConf = Number.parseInt(process.env.PUSH_LIVE_MIN_CONFIDENCE || "68", 10);
  if ((Number(row.confidence) || 0) < minConf) return { sentCount: 0, skipped: "low_confidence" };
  const tokens = await listTokensForPref("live");
  const hg = Number(row.home_goals) || 0;
  const ag = Number(row.away_goals) || 0;
  const home = row.home_team_name || "Local";
  const away = row.away_team_name || "Visitante";
  return sendToTokens(tokens, {
    title: "Tip en vivo",
    body: `${home} ${hg}-${ag} ${away} · ${row.prediction || ""}`.slice(0, 180),
    data: {
      type: "live_pick",
      prediction_id: String(row.id || ""),
    },
  });
}

async function notifyNewsItem(row) {
  const tokens = await listTokensForPref("news");
  return sendToTokens(tokens, {
    title: "Noticia MatuPicks",
    body: String(row.title || row.summary || "Nueva noticia").slice(0, 180),
    data: {
      type: "news",
      news_id: String(row.id || ""),
      slug: String(row.slug || ""),
    },
  });
}

/**
 * Aviso a seguidores cuando un tip pasa a won/lost.
 */
async function notifyFollowedSettled(row, outcome = "won") {
  const predictionId = String(row.id || row.prediction_id || "").trim();
  if (!predictionId) return { sentCount: 0, reason: "no_id" };
  if (outcome !== "won" && outcome !== "lost" && outcome !== "void") {
    return { sentCount: 0, reason: "bad_outcome" };
  }

  let userIds = [];
  try {
    const { data, error } = await db
      .from("pf_prediction_follows")
      .select("user_id")
      .eq("prediction_id", predictionId)
      .limit(400);
    if (!error) userIds = (data || []).map((r) => String(r.user_id)).filter(Boolean);
  } catch {
    /* ignore */
  }

  if (!userIds.length) return { sentCount: 0, reason: "no_followers" };

  const tokens = await listTokensForUserIds(userIds, true);
  const home = row.home_team_name || row.homeTeam?.name || "Local";
  const away = row.away_team_name || row.awayTeam?.name || "Visitante";
  const label = outcome === "won" ? "Acertado" : outcome === "lost" ? "Fallido" : "Anulado";
  const hg = Number(row.home_goals) || 0;
  const ag = Number(row.away_goals) || 0;
  return sendToTokens(tokens, {
    title: `Tip ${label}`,
    body: `${home} ${hg}-${ag} ${away} · ${row.prediction || ""}`.slice(0, 180),
    data: {
      type: "followed_result",
      outcome: String(outcome),
      prediction_id: predictionId,
    },
  });
}

module.exports = {
  notifyNewPublishedPick,
  notifyLivePick,
  notifyNewsItem,
  notifyFollowedSettled,
  listTokensForPref,
};
