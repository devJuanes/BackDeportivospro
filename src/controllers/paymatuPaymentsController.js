const crypto = require("crypto");
const logger = require("../utils/logger");
const {
  createPaymentLink,
  getPaymentStatus,
  paymatuConfigured,
} = require("../services/paymatuService");
const { grantVipAfterApprovedPayment } = require("../services/vipSubscriptionService");
const { parsePfVipUserIdFromReference } = require("../services/wompiService");
const {
  publicPricing,
  usdForPlan,
  minutesForPlan,
  minutesForUsd,
  minTopupUsd,
  formatVipDuration,
  estimateCop,
  FALLBACK_COP_PER_USD,
} = require("../config/vipPricing");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PAID = new Set(["PAID", "APPROVED", "SALE_APPROVED"]);

function frontendVipReturnUrl() {
  const base = String(
    process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:5173",
  ).replace(/\/$/, "");
  return `${base}/vip`;
}

function getPaymatuStatus(_req, res) {
  const pricing = publicPricing(FALLBACK_COP_PER_USD);
  return res.json({
    enabled: paymatuConfigured(),
    provider: "paymatubyte",
    environment: process.env.NODE_ENV === "production" ? "live" : "sandbox",
    currency: "COP",
    chargeCurrency: "USD",
    pricing,
  });
}

/**
 * POST /api/payments/paymatu/checkout
 * Body: { userId, email, plan?: 'weekly'|'monthly', amountUsd?: number }
 */
async function createPaymatuVipCheckout(req, res) {
  try {
    if (!paymatuConfigured()) {
      return res.status(503).json({
        error: "Pagos no configurados",
        hint: "Define PAYMATUBYTE_URL y PAYMATUBYTE_API_KEY (apiKey de config/apps/super-win.yaml).",
      });
    }

    const { userId, email, plan: planRaw, amountUsd: amountRaw } = req.body || {};
    if (!userId || !UUID_RE.test(String(userId))) {
      return res.status(400).json({ error: "userId UUID requerido" });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "email válido requerido" });
    }

    const suffix = crypto.randomBytes(6).toString("hex");
    const ts = Date.now();
    let reference;
    let amountUsd;
    let description;
    let productId;
    let minutes;

    if (amountRaw != null && amountRaw !== "") {
      amountUsd = Number(amountRaw);
      if (!Number.isFinite(amountUsd) || amountUsd < minTopupUsd()) {
        return res.status(400).json({
          error: `Recarga mínima USD ${minTopupUsd()}`,
        });
      }
      // Redondeo a céntimos de dólar
      amountUsd = Math.round(amountUsd * 100) / 100;
      minutes = minutesForUsd(amountUsd);
      reference = `pfvip-${userId}-mn${minutes}-${ts}-${suffix}`;
      description = `Recarga VIP SuperWin USD ${amountUsd}`;
    } else {
      const plan =
        planRaw === "weekly" ? "weekly" : planRaw === "annual" ? "annual" : "monthly";
      amountUsd = usdForPlan(plan);
      minutes = minutesForPlan(plan);
      const tag = plan === "weekly" ? "wk" : plan === "annual" ? "yr" : "mo";
      reference = `pfvip-${userId}-${tag}-${ts}-${suffix}`;
      description =
        plan === "weekly"
          ? "VIP Semanal SuperWin"
          : plan === "annual"
            ? "VIP Anual SuperWin"
            : "VIP Mensual SuperWin";
      productId = plan === "weekly" ? "vip-weekly" : plan === "monthly" ? "vip-monthly" : undefined;
    }

    const created = await createPaymentLink({
      amountUsd,
      reference,
      description,
      productId,
      returnUrl: frontendVipReturnUrl(),
    });

    const data = created?.data || created || {};
    const url = String(data.url || data.checkoutUrl || "");
    if (!url) {
      return res.status(502).json({ error: "PayMatuByte no devolvió URL de checkout" });
    }

    const duration = formatVipDuration(minutes);
    logger.info(
      `[paymatu] checkout user=${userId} ref=${reference} usd=${amountUsd} minutes=${minutes}`,
    );

    return res.json({
      url,
      checkoutUrl: url,
      reference: data.reference || reference,
      linkId: data.link_id || null,
      amountUsd,
      estimatedCop: estimateCop(amountUsd),
      minutes,
      duration,
      currency: data.currency || "COP",
    });
  } catch (e) {
    logger.error("[paymatu] checkout error", e);
    return res.status(e.status && e.status < 500 ? e.status : 500).json({
      error: e.message || "No se pudo iniciar el pago",
    });
  }
}

/**
 * POST /api/payments/paymatu/confirm-return
 * Body: { reference, userId }
 */
async function confirmPaymatuReturn(req, res) {
  try {
    if (!paymatuConfigured()) {
      return res.status(503).json({ error: "Pagos no configurados" });
    }

    const reference = String(req.body?.reference || "").trim();
    const userId = String(req.body?.userId || "").trim();
    if (!userId || !UUID_RE.test(userId)) {
      return res.status(400).json({ error: "userId UUID requerido" });
    }
    if (!reference) {
      return res.status(400).json({ error: "reference requerida" });
    }

    const txUser = parsePfVipUserIdFromReference(reference);
    if (!txUser || txUser !== userId) {
      return res.status(403).json({
        error: "Este pago no corresponde a tu cuenta.",
        reference,
      });
    }

    const statusPayload = await getPaymentStatus(reference);
    const data = statusPayload?.data || statusPayload || {};
    const status = String(data.status || "").toUpperCase();
    const transactionId =
      data.transaction_id != null
        ? String(data.transaction_id)
        : data.id != null
          ? String(data.id)
          : reference;

    let granted = false;
    let vipExpiresAt = null;
    let alreadyRedeemed = false;
    let minutes = 0;

    if (PAID.has(status)) {
      try {
        const r = await grantVipAfterApprovedPayment(userId, reference, transactionId);
        granted = r.granted;
        vipExpiresAt = r.vipExpiresAt;
        alreadyRedeemed = r.alreadyRedeemed;
        minutes = r.minutes || 0;
      } catch {
        return res.status(500).json({ error: "No se pudo actualizar el VIP en base de datos." });
      }
    }

    return res.json({
      status,
      reference,
      transactionId,
      granted,
      alreadyRedeemed,
      vipExpiresAt,
      minutes,
      duration: formatVipDuration(minutes),
      paid: PAID.has(status),
    });
  } catch (e) {
    logger.error("[paymatu] confirm-return error", e);
    return res.status(e.status && e.status < 500 ? e.status : 500).json({
      error: e.message || "Error al confirmar el pago",
    });
  }
}

module.exports = {
  getPaymatuStatus,
  createPaymatuVipCheckout,
  confirmPaymatuReturn,
};
