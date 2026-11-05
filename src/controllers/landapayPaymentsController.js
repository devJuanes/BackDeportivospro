const crypto = require("crypto");
const logger = require("../utils/logger");
const {
  landapayConfigured,
  createVipPaymentLink,
  retrievePayment,
  constructWebhookEvent,
  isLivemode,
  SignatureVerificationError,
} = require("../services/landapayService");
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

function frontendBaseUrl() {
  return String(
    process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:5173",
  ).replace(/\/$/, "");
}

function frontendReturnUrl(path = "/vip") {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${frontendBaseUrl()}${clean}`;
}

function metaString(meta, key) {
  if (!meta || typeof meta !== "object") return "";
  const v = meta[key];
  return v == null ? "" : String(v);
}

async function grantFromApprovedPayment(payment) {
  const reference = metaString(payment.metadata, "reference");
  const userId = metaString(payment.metadata, "userId");
  if (!reference || !userId) {
    return {
      granted: false,
      alreadyRedeemed: false,
      vipExpiresAt: null,
      minutes: 0,
      error: "Pago sin metadata VIP",
    };
  }
  const txUser = parsePfVipUserIdFromReference(reference);
  if (txUser && txUser !== userId) {
    return {
      granted: false,
      alreadyRedeemed: false,
      vipExpiresAt: null,
      minutes: 0,
      error: "Metadata inconsistente",
    };
  }
  const r = await grantVipAfterApprovedPayment(userId, reference, payment.id);
  return { ...r, error: null };
}

function getLandapayStatus(_req, res) {
  const pricing = publicPricing(FALLBACK_COP_PER_USD);
  return res.json({
    enabled: landapayConfigured(),
    provider: "landapay",
    environment: isLivemode() ? "live" : "test",
    currency: "COP",
    chargeCurrency: "USD",
    pricing,
  });
}

/**
 * POST /api/payments/landapay/checkout
 * Body: { userId, email, plan?: 'weekly'|'monthly', amountUsd?: number }
 */
async function createLandapayVipCheckout(req, res) {
  try {
    if (!landapayConfigured()) {
      return res.status(503).json({
        error: "Pagos no configurados",
        hint: "Define LANDAPAY_API_KEY=lp_sk_test_... en el backend.",
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
    let title;
    let description;
    let minutes;

    let redirectPath = "/vip";
    if (amountRaw != null && amountRaw !== "") {
      amountUsd = Number(amountRaw);
      if (!Number.isFinite(amountUsd) || amountUsd < minTopupUsd()) {
        return res.status(400).json({
          error: `Recarga mínima USD ${minTopupUsd()}`,
        });
      }
      amountUsd = Math.round(amountUsd * 100) / 100;
      minutes = minutesForUsd(amountUsd);
      reference = `pfvip-${userId}-mn${minutes}-${ts}-${suffix}`;
      title = `Recarga VIP SuperWin ${amountUsd} USD`;
      description = `Tiempo VIP estimado: ${formatVipDuration(minutes).days}d ${formatVipDuration(minutes).hours}h`;
      redirectPath = "/depositar";
    } else {
      const plan =
        planRaw === "weekly" ? "weekly" : planRaw === "annual" ? "annual" : "monthly";
      amountUsd = usdForPlan(plan);
      minutes = minutesForPlan(plan);
      const tag = plan === "weekly" ? "wk" : plan === "annual" ? "yr" : "mo";
      reference = `pfvip-${userId}-${tag}-${ts}-${suffix}`;
      title =
        plan === "weekly"
          ? "VIP Semanal SuperWin"
          : plan === "annual"
            ? "VIP Anual SuperWin"
            : "VIP Mensual SuperWin";
      description = `${minutesForPlan(plan) / (24 * 60)} días de membresía VIP`;
      redirectPath = "/vip";
    }

    const link = await createVipPaymentLink({
      title,
      description,
      amountUsd,
      redirectUrl: frontendReturnUrl(redirectPath),
      metadata: {
        reference,
        userId: String(userId),
        email: String(email).trim().toLowerCase(),
        minutes: String(minutes),
        amountUsd: String(amountUsd),
      },
      idempotencyKey: reference,
    });

    const duration = formatVipDuration(minutes);
    logger.info(
      `[landapay] checkout user=${userId} ref=${reference} usd=${amountUsd} minutes=${minutes} plink=${link.id}`,
    );

    return res.json({
      url: link.url,
      checkoutUrl: link.url,
      reference,
      paymentLinkId: link.id,
      amountUsd,
      amountCentsUsd: Math.round(amountUsd * 100),
      estimatedCop: estimateCop(amountUsd),
      minutes,
      duration,
      currency: link.currency || "USD",
      livemode: Boolean(link.livemode),
    });
  } catch (e) {
    logger.error("[landapay] checkout error", e);
    const msg = e.message || "No se pudo iniciar el pago";
    const status =
      e.status && e.status >= 400 && e.status < 600
        ? e.status
        : /lp_sk_test_|lp_sk_live_|API key|api key|autentic/i.test(msg)
          ? 400
          : 500;
    return res.status(status).json({
      error: msg,
      requestId: e.requestId || undefined,
    });
  }
}

/**
 * POST /api/payments/landapay/confirm-return
 * Body: { paymentId, userId }
 * Volver del checkout NO confirma solo: hay que consultar payments.retrieve.
 */
async function confirmLandapayReturn(req, res) {
  try {
    if (!landapayConfigured()) {
      return res.status(503).json({ error: "Pagos no configurados" });
    }

    const paymentId = String(
      req.body?.paymentId || req.body?.payment_id || "",
    ).trim();
    const userId = String(req.body?.userId || "").trim();
    if (!userId || !UUID_RE.test(userId)) {
      return res.status(400).json({ error: "userId UUID requerido" });
    }
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId requerido" });
    }

    const payment = await retrievePayment(paymentId);
    const metaUser = metaString(payment.metadata, "userId");
    if (metaUser && metaUser !== userId) {
      return res.status(403).json({
        error: "Este pago no corresponde a tu cuenta.",
        paymentId,
      });
    }

    const status = String(payment.status || "").toLowerCase();
    let granted = false;
    let vipExpiresAt = null;
    let alreadyRedeemed = false;
    let minutes = 0;

    if (status === "approved") {
      try {
        const r = await grantFromApprovedPayment(payment);
        if (r.error && !r.granted && !r.alreadyRedeemed) {
          return res.status(400).json({ error: r.error, status, paymentId });
        }
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
      paymentId: payment.id,
      paymentLinkId: payment.paymentLink || null,
      reference: metaString(payment.metadata, "reference") || null,
      granted,
      alreadyRedeemed,
      vipExpiresAt,
      minutes,
      duration: formatVipDuration(minutes),
      paid: status === "approved",
    });
  } catch (e) {
    logger.error("[landapay] confirm-return error", e);
    return res.status(e.status && e.status < 500 ? e.status : 500).json({
      error: e.message || "Error al confirmar el pago",
      requestId: e.requestId || undefined,
    });
  }
}

/**
 * POST /api/payments/landapay/webhook
 * Requiere body crudo (Buffer) + header Landa-Signature.
 */
async function landapayWebhook(req, res) {
  try {
    if (!landapayConfigured()) {
      return res.status(503).send("LANDAPAY_API_KEY missing");
    }
    const signature = req.get("Landa-Signature");
    const raw = req.body;
    let event;
    try {
      event = constructWebhookEvent(raw, signature);
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        logger.warn("[landapay] webhook firma inválida");
        return res.status(400).send(error.message || "Invalid signature");
      }
      throw error;
    }

    if (event.type === "payment.approved") {
      const payment = event.data.object;
      try {
        const r = await grantFromApprovedPayment(payment);
        logger.info(
          `[landapay] webhook payment.approved pay=${payment.id} granted=${r.granted} redeemed=${r.alreadyRedeemed}`,
        );
      } catch (e) {
        logger.error("[landapay] webhook grant failed", e);
        return res.status(500).send("grant failed");
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    logger.error("[landapay] webhook error", e);
    return res.status(500).send("webhook error");
  }
}

module.exports = {
  getLandapayStatus,
  createLandapayVipCheckout,
  confirmLandapayReturn,
  landapayWebhook,
};
