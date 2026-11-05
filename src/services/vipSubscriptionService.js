const logger = require("../utils/logger");
const { executeRawSql } = require("../config/database");
const { parsePfVipMetaFromReference } = require("./wompiService");
const { minutesForPlan } = require("../config/vipPricing");

/** Días/minutos por etiqueta de plan en referencia. */
const PLAN_TAG_DAYS = { wk: 7, mo: 30, yr: 365 };

function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

function resolveGrantMinutes(meta) {
  if (!meta) return 0;
  if (meta.planTag === "mn" && Number.isFinite(meta.minutes) && meta.minutes > 0) {
    return Math.floor(meta.minutes);
  }
  if (meta.planTag === "wk") return minutesForPlan("weekly");
  if (meta.planTag === "yr") return minutesForPlan("annual");
  if (meta.planTag === "mo") return minutesForPlan("monthly");
  return 0;
}

/**
 * Idempotencia por `reference` (única por cobro): webhook y confirm-return no duplican tiempo VIP.
 * Acumula sobre vip_expires_at vigente.
 * @returns {{ granted: boolean, vipExpiresAt: string | null, alreadyRedeemed: boolean, minutes: number }}
 */
async function grantVipAfterApprovedPayment(userId, reference, paymentTransactionId) {
  const meta = parsePfVipMetaFromReference(reference);
  if (!meta || meta.userId !== userId) {
    return { granted: false, vipExpiresAt: null, alreadyRedeemed: false, minutes: 0 };
  }
  const minutes = resolveGrantMinutes(meta);
  if (!minutes || minutes <= 0) {
    return { granted: false, vipExpiresAt: null, alreadyRedeemed: false, minutes: 0 };
  }

  const refEsc = sqlEscape(reference);
  const uidEsc = sqlEscape(userId);
  const tid =
    paymentTransactionId != null && String(paymentTransactionId).trim()
      ? sqlEscape(String(paymentTransactionId).trim())
      : null;
  const tidSql = tid ? `'${tid}'` : "NULL";

  const sql = `
WITH ins AS (
  INSERT INTO wompi_vip_redemptions (reference, wompi_transaction_id, user_id)
  SELECT '${refEsc}', ${tidSql}, '${uidEsc}'
  WHERE NOT EXISTS (SELECT 1 FROM wompi_vip_redemptions WHERE reference = '${refEsc}')
  RETURNING 1
),
upd AS (
  UPDATE pf_users SET
    is_vip = true,
    vip_expires_at = (
      CASE
        WHEN vip_expires_at IS NOT NULL AND vip_expires_at > NOW()
        THEN vip_expires_at + (${minutes}::text || ' minutes')::interval
        ELSE NOW() + (${minutes}::text || ' minutes')::interval
      END
    ),
    updated_at = NOW()
  WHERE (id::text = '${uidEsc}' OR firebase_uid = '${uidEsc}')
    AND EXISTS (SELECT 1 FROM ins)
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
    if (granted) {
      logger.info(
        `[vip] Otorgado user=${userId} ref_tail=${reference.slice(-28)} minutes=${minutes}`,
      );
    }
    return {
      granted,
      vipExpiresAt: vipExpiresAt ? String(vipExpiresAt) : null,
      alreadyRedeemed,
      minutes,
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
  resolveGrantMinutes,
};
