/**
 * Push FCM cuando hay tips nuevos o en vivo (requiere Firebase + tokens registrados).
 */
const logger = require("../utils/logger");
const { db } = require("../config/database");
const { sendPushToTokens } = require("./firebasePushService");
const { scrubPlayStoreText } = require("../utils/playStoreSafe");

async function listMatupicksTokens(limit = 500) {
  const tokens = new Set();
  for (const table of ["project_push_tokens", "mp_push_tokens"]) {
    try {
      const { data, error } = await db.from(table).select("fcm_token,token").limit(limit);
      if (error) continue;
      for (const row of data || []) {
        const t = row.fcm_token || row.token;
        if (t) tokens.add(String(t).trim());
      }
    } catch {
      /* tabla opcional */
    }
  }
  return [...tokens];
}

async function broadcastPush({ title, body, data = {} }) {
  if (String(process.env.PREDICTION_PUSH_ENABLED || "true").toLowerCase() === "false") {
    return { sentCount: 0, skipped: true };
  }
  const tokens = await listMatupicksTokens();
  if (!tokens.length) return { sentCount: 0, reason: "no_tokens" };
  try {
    return await sendPushToTokens({
      tokens,
      title: scrubPlayStoreText(title),
      body: scrubPlayStoreText(body),
      data,
      channelId: "matupicks_tips",
    });
  } catch (error) {
    logger.warn(`[push-tips] ${error.message}`);
    return { sentCount: 0, error: error.message };
  }
}

async function notifyNewPublishedPick(row, tier = "free") {
  const home = row.home_team_name || row.homeTeam?.name || "Local";
  const away = row.away_team_name || row.awayTeam?.name || "Visitante";
  return broadcastPush({
    title: tier === "vip" ? "Nuevo tip VIP" : "Nuevo tip del día",
    body: `${home} vs ${away} · ${row.prediction || ""}`.slice(0, 180),
    data: { type: "new_pick", tier: String(tier) },
  });
}

async function notifyLivePick(row) {
  const minConf = Number.parseInt(process.env.PUSH_LIVE_MIN_CONFIDENCE || "68", 10);
  if ((Number(row.confidence) || 0) < minConf) return { sentCount: 0, skipped: "low_confidence" };
  const hg = Number(row.home_goals) || 0;
  const ag = Number(row.away_goals) || 0;
  const home = row.home_team_name || "Local";
  const away = row.away_team_name || "Visitante";
  return broadcastPush({
    title: "Tip en vivo",
    body: `${home} ${hg}-${ag} ${away} · ${row.prediction || ""}`.slice(0, 180),
    data: { type: "live_pick" },
  });
}

module.exports = {
  broadcastPush,
  notifyNewPublishedPick,
  notifyLivePick,
  listMatupicksTokens,
};
