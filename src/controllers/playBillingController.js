const logger = require("../utils/logger");
const { executeRawSql } = require("../config/database");
const { grantVipMinutes } = require("../services/vipSubscriptionService");
const {
  playBillingEnabled,
  verifyPurchase,
  acknowledgeSubscription,
} = require("../services/googlePlayBillingService");
const { formatVipDuration } = require("../config/vipPricing");

function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

function isValidUserId(userId) {
  const id = String(userId || "").trim();
  return id.length >= 8 && id.length <= 128;
}

/**
 * Idempotencia por purchaseToken (único por cobro Play).
 */
async function alreadyRedeemedToken(purchaseToken) {
  const sql = `
SELECT reference, user_id, created_at
FROM wompi_vip_redemptions
WHERE reference = '${sqlEscape(`play:${purchaseToken}`)}'
   OR wompi_transaction_id = '${sqlEscape(purchaseToken)}'
LIMIT 1;
`;
  try {
    const data = await executeRawSql(sql);
    const row = Array.isArray(data) ? data[0] : data?.rows?.[0];
    return Boolean(row);
  } catch {
    return false;
  }
}

function getPlayStatus(_req, res) {
  return res.json({
    enabled: playBillingEnabled(),
    provider: "google_play",
    note: "La app Android valida purchaseToken aquí; el navegador usa Landa Pay.",
  });
}

/**
 * POST /api/payments/play/verify
 * Body: { purchaseToken, productId, packageName, userId, orderId? }
 * Grant solo tras verificación con Google. Minutos según productId allowlisted.
 */
async function verifyPlayPurchase(req, res) {
  try {
    if (!playBillingEnabled()) {
      return res.status(503).json({
        error: "Play Billing no habilitado en el servidor",
        hint: "Define PLAY_BILLING_ENABLED=true y PLAY_SERVICE_ACCOUNT_JSON",
      });
    }

    const purchaseToken = String(req.body?.purchaseToken || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const packageName = String(req.body?.packageName || "").trim();
    const userId = String(req.body?.userId || "").trim();
    const orderId = String(req.body?.orderId || "").trim() || null;

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: "userId inválido" });
    }
    if (!purchaseToken || !productId || !packageName) {
      return res.status(400).json({
        error: "purchaseToken, productId y packageName son requeridos",
      });
    }

    // Auth opcional: si hay Bearer, el userId del body debe coincidir con el del token (si el middleware lo setea).
    const authUserId = req.user?.id || req.auth?.userId || null;
    if (authUserId && String(authUserId) !== userId) {
      return res.status(403).json({ error: "userId no coincide con la sesión" });
    }

    if (await alreadyRedeemedToken(purchaseToken)) {
      return res.json({
        ok: true,
        granted: false,
        alreadyRedeemed: true,
        productId,
        packageName,
      });
    }

    const verified = await verifyPurchase({
      packageName,
      productId,
      purchaseToken,
    });

    if (!verified.valid) {
      return res.status(400).json({
        error: "Compra de Google Play no válida o pendiente",
        productId,
      });
    }

    const minutes = verified.grant.minutes;
    const reference = `play:${purchaseToken}`;
    const r = await grantVipMinutes(
      userId,
      reference,
      orderId || purchaseToken,
      minutes,
    );

    if (verified.kind === "subscription") {
      await acknowledgeSubscription({ packageName, productId, purchaseToken });
    }

    logger.info(
      `[play] verify ok user=${userId} pkg=${packageName} sku=${productId} plan=${verified.grant.plan} granted=${r.granted} redeemed=${r.alreadyRedeemed}`,
    );

    return res.json({
      ok: true,
      granted: r.granted,
      alreadyRedeemed: r.alreadyRedeemed,
      vipExpiresAt: r.vipExpiresAt,
      minutes: r.minutes,
      duration: formatVipDuration(r.minutes),
      plan: verified.grant.plan,
      productId,
      packageName,
      provider: "google_play",
    });
  } catch (e) {
    logger.error("[play] verify error", e);
    return res.status(e.status && e.status < 500 ? e.status : 500).json({
      error: e.message || "Error al verificar compra Play",
    });
  }
}

module.exports = {
  getPlayStatus,
  verifyPlayPurchase,
};
