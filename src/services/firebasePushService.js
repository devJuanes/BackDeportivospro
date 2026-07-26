const { ensureInitialized, getAdmin } = require("./firebaseAdmin");

async function sendPushToTokens({
  tokens,
  title,
  body,
  data = {},
  channelId = "matu_call_push",
}) {
  const clean = (tokens || []).map((t) => String(t || "").trim()).filter(Boolean);
  if (!clean.length) return { sentCount: 0, failureCount: 0, responses: [] };
  if (!ensureInitialized()) {
    throw new Error("Firebase no configurado (FIREBASE_SERVICE_ACCOUNT_JSON/BASE64)");
  }
  const admin = getAdmin();
  const payload = {
    tokens: clean,
    notification: { title: String(title || ""), body: String(body || "") },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [String(k), String(v ?? "")])
    ),
    android: {
      priority: "high",
      notification: {
        channelId,
        sound: "default",
      },
    },
  };
  const result = await admin.messaging().sendEachForMulticast(payload);
  return {
    sentCount: result.successCount,
    failureCount: result.failureCount,
    responses: result.responses.map((r) => ({
      success: r.success,
      messageId: r.messageId || null,
      errorCode: r.error?.code || null,
      errorMessage: r.error?.message || null,
    })),
  };
}

module.exports = { sendPushToTokens };
