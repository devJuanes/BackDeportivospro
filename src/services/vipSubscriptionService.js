const logger = require("../utils/logger");
const { executeRawSql } = require("../config/database");
const { parsePfVipMetaFromReference } = require("./wompiService");

/** Días sumados por etiqueta en referencia pfvip-*-(wk|mo|yr)- */
const PLAN_TAG_DAYS = { wk: 7, mo: 30, yr: 365 };

function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

/**
 * Idempotencia por `reference` Wompi (única por cobro): webhook y confirm-return no duplican días VIP.
 * @returns {{ granted: boolean, vipExpiresAt: string | null, alreadyRedeemed: boolean }}
 */
async function grantVipAfterApprovedPayment(userId, reference, wompiTransactionId) {
  const meta = parsePfVipMetaFromReference(reference);
  if (!meta || meta.userId !== userId) {
    return { granted: false, vipExpiresAt: null, alreadyRedeemed: false };
  }
  const days = PLAN_TAG_DAYS[meta.planTag];
  if (!days) return { granted: false, vipExpiresAt: null, alreadyRedeemed: false };

  const refEsc = sqlEscape(reference);
  const uidEsc = sqlEscape(userId);
  const tid =
    wompiTransactionId != null && String(wompiTransactionId).trim()
      ? sqlEscape(String(wompiTransactionId).trim())
      : null;
  const tidSql = tid ? `'${tid}'` : "NULL";

  const sql = `
WITH ins AS (
  INSERT INTO wompi_vip_redemptions (reference, wompi_transaction_id, user_id)
  SELECT '${refEsc}', ${tidSql}, '${uidEsc}'::uuid
  WHERE NOT EXISTS (SELECT 1 FROM wompi_vip_redemptions WHERE reference = '${refEsc}')
  RETURNING 1
),
upd AS (
  UPDATE pf_users SET
    is_vip = true,
    vip_expires_at = (
      CASE
        WHEN vip_expires_at IS NOT NULL AND vip_expires_at > NOW()
        THEN vip_expires_at + (${days}::text || ' days')::interval
        ELSE NOW() + (${days}::text || ' days')::interval
      END
    ),
    updated_at = NOW()
  WHERE id = '${uidEsc}'::uuid AND EXISTS (SELECT 1 FROM ins)
  RETURNING vip_expires_at::text AS vip_expires_at
)
SELECT
  (SELECT COUNT(*) FROM ins) AS inserted,
  (SELECT vip_expires_at FROM upd LIMIT 1) AS vip_expires_at;
`;

  try {
    const data = await executeRawSql(sql);
    const row = Array.isArray(data)
      ? data[0]
      : data?.rows?.[0] ?? (data && typeof data === "object" ? data : null);
    const inserted = Number(row?.inserted ?? row?.INSERTED ?? 0);
    const vipExpiresAt = row?.vip_expires_at ?? row?.VIP_EXPIRES_AT ?? null;
    const granted = inserted > 0 && vipExpiresAt != null;
    const alreadyRedeemed = inserted === 0;
    if (granted) logger.info(`[vip] Otorgado por pago user=${userId} ref_tail=${reference.slice(-24)} days=${days}`);
    return {
      granted,
      vipExpiresAt: vipExpiresAt ? String(vipExpiresAt) : null,
      alreadyRedeemed,
    };
  } catch (e) {
    logger.error("[vip] grantVipAfterApprovedPayment", e);
    throw e;
  }
}

async function expireStaleVipSubscriptions() {
  const sql = `
UPDATE pf_users SET is_vip = false, updated_at = NOW()
WHERE is_vip = true
  AND vip_expires_at IS NOT NULL
  AND vip_expires_at < NOW();
`;
  try {
    await executeRawSql(sql);
  } catch (e) {
    logger.warn(`[vip] expireStaleVipSubscriptions: ${e.message}`);
  }
}

module.exports = {
  grantVipAfterApprovedPayment,
  expireStaleVipSubscriptions,
  PLAN_TAG_DAYS,
};
