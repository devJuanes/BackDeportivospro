/**
 * Alertas a canal de Telegram (tips en vivo de alta confianza).
 * TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID en .env
 */
const axios = require("axios");
const logger = require("../utils/logger");
const { scrubPlayStoreText } = require("../utils/playStoreSafe");

function isConfigured() {
  return Boolean(
    String(process.env.TELEGRAM_BOT_TOKEN || "").trim() &&
      String(process.env.TELEGRAM_CHANNEL_ID || "").trim()
  );
}

async function sendTelegramMessage(text, options = {}) {
  if (!isConfigured()) return { sent: false, reason: "not_configured" };
  const token = process.env.TELEGRAM_BOT_TOKEN.trim();
  const chatId = process.env.TELEGRAM_CHANNEL_ID.trim();
  const body = scrubPlayStoreText(text);
  if (!body) return { sent: false, reason: "empty" };

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(
      url,
      {
        chat_id: chatId,
        text: body.slice(0, 4000),
        disable_web_page_preview: true,
        parse_mode: options.parseMode || undefined,
      },
      { timeout: 12000 }
    );
    return { sent: true };
  } catch (error) {
    logger.warn(`[telegram] ${error.message}`);
    return { sent: false, reason: error.message };
  }
}

async function notifyLiveTip(row) {
  const minConf = Number.parseInt(process.env.TELEGRAM_LIVE_MIN_CONFIDENCE || "70", 10);
  const conf = Number(row.confidence) || 0;
  if (conf < minConf) return { sent: false, reason: "low_confidence" };

  const hg = Number(row.home_goals) || 0;
  const ag = Number(row.away_goals) || 0;
  const minute = Number(row.minute) || 0;
  const text = [
    "🔴 EN VIVO · MatuPicks",
    `${row.home_team_name} ${hg}-${ag} ${row.away_team_name}`,
    minute > 0 ? `Min ${minute}'` : null,
    scrubPlayStoreText(row.prediction || ""),
    conf > 0 ? `Confianza ${conf}%` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return sendTelegramMessage(text);
}

module.exports = {
  isConfigured,
  sendTelegramMessage,
  notifyLiveTip,
};
