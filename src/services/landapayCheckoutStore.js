const logger = require("../utils/logger");
const { executeRawSql } = require("../config/database");

function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

function mapRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    paymentLinkId: String(row.payment_link_id || row.PAYMENT_LINK_ID || ""),
    reference: String(row.reference || row.REFERENCE || ""),
    userId: String(row.user_id || row.USER_ID || ""),
    email: row.email != null ? String(row.email) : null,
    minutes: Number(row.minutes || row.MINUTES || 0),
    amountUsd: Number(row.amount_usd || row.AMOUNT_USD || 0),
    paymentId: row.payment_id != null ? String(row.payment_id) : null,
    status: String(row.status || row.STATUS || "pending"),
    grantedAt: row.granted_at || row.GRANTED_AT || null,
  };
}

async function saveCheckout({
  paymentLinkId,
  reference,
  userId,
  email,
  minutes,
  amountUsd,
}) {
  const sql = `
INSERT INTO landapay_vip_checkouts (
  payment_link_id, reference, user_id, email, minutes, amount_usd, status
) VALUES (
  '${sqlEscape(paymentLinkId)}',
  '${sqlEscape(reference)}',
  '${sqlEscape(userId)}',
  ${email ? `'${sqlEscape(email)}'` : "NULL"},
  ${Math.floor(Number(minutes) || 0)},
  ${Number(amountUsd) || 0},
  'pending'
)
ON CONFLICT (payment_link_id) DO UPDATE SET
  reference = EXCLUDED.reference,
  user_id = EXCLUDED.user_id,
  email = EXCLUDED.email,
  minutes = EXCLUDED.minutes,
  amount_usd = EXCLUDED.amount_usd;
`;
  await executeRawSql(sql);
}

async function findCheckoutByPaymentLinkId(paymentLinkId) {
  const id = String(paymentLinkId || "").trim();
  if (!id) return null;
  const sql = `
SELECT payment_link_id, reference, user_id, email, minutes, amount_usd, payment_id, status, granted_at
FROM landapay_vip_checkouts
WHERE payment_link_id = '${sqlEscape(id)}'
LIMIT 1;
`;
  try {
    const data = await executeRawSql(sql);
    const row = Array.isArray(data)
      ? data[0]
      : data?.rows?.[0] ?? (data && typeof data === "object" && !Array.isArray(data) ? data : null);
    return mapRow(row);
  } catch (e) {
    logger.warn(`[landapay] findCheckoutByPaymentLinkId: ${e.message}`);
    return null;
  }
}

async function findCheckoutByPaymentId(paymentId) {
  const id = String(paymentId || "").trim();
  if (!id) return null;
  const sql = `
SELECT payment_link_id, reference, user_id, email, minutes, amount_usd, payment_id, status, granted_at
FROM landapay_vip_checkouts
WHERE payment_id = '${sqlEscape(id)}'
LIMIT 1;
`;
  try {
    const data = await executeRawSql(sql);
    const row = Array.isArray(data)
      ? data[0]
      : data?.rows?.[0] ?? null;
    return mapRow(row);
  } catch (e) {
    logger.warn(`[landapay] findCheckoutByPaymentId: ${e.message}`);
    return null;
  }
}

async function listCheckoutsByUserId(userId, limit = 30) {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const lim = Math.min(50, Math.max(1, Number(limit) || 30));
  const sql = `
SELECT payment_link_id, reference, user_id, email, minutes, amount_usd, payment_id, status, granted_at, created_at
FROM landapay_vip_checkouts
WHERE user_id = '${sqlEscape(uid)}'
ORDER BY created_at DESC
LIMIT ${lim};
`;
  try {
    const data = await executeRawSql(sql);
    const rows = Array.isArray(data) ? data : data?.rows || [];
    return rows.map((row) => ({
      ...mapRow(row),
      createdAt: row.created_at || row.CREATED_AT || null,
    })).filter((r) => r.paymentLinkId);
  } catch (e) {
    logger.warn(`[landapay] listCheckoutsByUserId: ${e.message}`);
    return [];
  }
}

async function markCheckoutPaid(paymentLinkId, paymentId) {
  const sql = `
UPDATE landapay_vip_checkouts SET
  payment_id = '${sqlEscape(paymentId)}',
  status = 'approved',
  granted_at = COALESCE(granted_at, NOW())
WHERE payment_link_id = '${sqlEscape(paymentLinkId)}';
`;
  await executeRawSql(sql);
}

async function markWebhookEventProcessed(eventId, eventType) {
  const id = String(eventId || "").trim();
  if (!id) return false;
  const sql = `
INSERT INTO landapay_webhook_events (event_id, event_type)
VALUES ('${sqlEscape(id)}', ${eventType ? `'${sqlEscape(eventType)}'` : "NULL"})
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id;
`;
  try {
    const data = await executeRawSql(sql);
    const row = Array.isArray(data) ? data[0] : data?.rows?.[0];
    return Boolean(row?.event_id || row?.EVENT_ID);
  } catch (e) {
    logger.warn(`[landapay] markWebhookEventProcessed: ${e.message}`);
    return true; // no bloquear si la tabla falla
  }
}

module.exports = {
  saveCheckout,
  findCheckoutByPaymentLinkId,
  findCheckoutByPaymentId,
  listCheckoutsByUserId,
  markCheckoutPaid,
  markWebhookEventProcessed,
};
