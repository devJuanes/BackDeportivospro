const crypto = require("crypto");
const logger = require("../utils/logger");
const {
  landapayConfigured,
  createVipPaymentLink,
  retrievePayment,
  retrievePaymentLink,
  constructWebhookEvent,
  isLivemode,
  SignatureVerificationError,
} = require("../services/landapayService");
const { grantVipMinutes } = require("../services/vipSubscriptionService");
const {
  saveCheckout,
  findCheckoutByPaymentLinkId,
  findCheckoutByPaymentId,
  listCheckoutsByUserId,
  markCheckoutPaid,
  markWebhookEventProcessed,
} = require("../services/landapayCheckoutStore");
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

function frontendBaseUrl() {
  return String(
    process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      "https://winquina.com",
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

function isValidUserId(userId) {
  const id = String(userId || "").trim();
  return id.length >= 8 && id.length <= 128;
}

/** Una sola consulta a Landa — sin reintentos ni bucles. */
async function retrievePaymentOnce(paymentId) {
  return retrievePayment(paymentId);
}

/**
 * Resuelve userId/minutes/reference.
 * Landa NO copia metadata al Payment — vive en el PaymentLink y en nuestra DB.
 */
async function resolveCheckoutContext(payment) {
  const paymentLinkId = String(payment?.paymentLink || "").trim();
  const paymentId = String(payment?.id || "").trim();

  let checkout =
    (paymentLinkId && (await findCheckoutByPaymentLinkId(paymentLinkId))) ||
    (paymentId && (await findCheckoutByPaymentId(paymentId))) ||
    null;

  if (checkout?.userId && checkout.minutes > 0) {
    return {
      paymentLinkId: checkout.paymentLinkId || paymentLinkId,
      reference: checkout.reference || paymentId,
      userId: checkout.userId,
      minutes: checkout.minutes,
      source: "db",
    };
  }

  if (paymentLinkId) {
    try {
      const link = await retrievePaymentLink(paymentLinkId);
      const userId = metaString(link.metadata, "userId");
      const minutes = Number(metaString(link.metadata, "minutes"));
      const reference =
        metaString(link.metadata, "reference") || paymentId || paymentLinkId;
      if (userId && Number.isFinite(minutes) && minutes > 0) {
        return {
          paymentLinkId,
          reference,
          userId,
          minutes,
          source: "payment_link",
        };
      }
    } catch (e) {
      logger.warn(`[landapay] retrievePaymentLink failed: ${e.message}`);
    }
  }

  // Último recurso: metadata en el payment (algunos entornos la copian)
  const userId = metaString(payment?.metadata, "userId");
  const minutes = Number(metaString(payment?.metadata, "minutes"));
  const reference =
    metaString(payment?.metadata, "reference") || paymentId || paymentLinkId;
  if (userId && Number.isFinite(minutes) && minutes > 0) {
    return { paymentLinkId, reference, userId, minutes, source: "payment_meta" };
  }

  return null;
}

async function grantFromApprovedPayment(payment) {
  const ctx = await resolveCheckoutContext(payment);
  if (!ctx) {
    return {
      granted: false,
      alreadyRedeemed: false,
      vipExpiresAt: null,
      minutes: 0,
      error: "Checkout VIP no encontrado para este payment_link_id",
    };
  }

  const r = await grantVipMinutes(
    ctx.userId,
    ctx.reference,
    payment.id,
    ctx.minutes,
  );

  if (ctx.paymentLinkId && (r.granted || r.alreadyRedeemed)) {
    try {
      await markCheckoutPaid(ctx.paymentLinkId, payment.id);
    } catch (e) {
      logger.warn(`[landapay] markCheckoutPaid: ${e.message}`);
    }
  }

  return { ...r, error: null, source: ctx.source, userId: ctx.userId };
}

function getLandapayStatus(_req, res) {
  const pricing = publicPricing(FALLBACK_COP_PER_USD);
  return res.json({
    enabled: landapayConfigured(),
    provider: "landapay",
    environment: isLivemode() ? "live" : "test",
    currency: "COP",
    chargeCurrency: "USD",
    frontendUrl: frontendBaseUrl(),
    webhookPath: "/api/payments/landapay/webhook",
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
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: "userId inválido" });
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
      reference = `swvip-${String(userId).slice(0, 36)}-mn${minutes}-${ts}-${suffix}`;
      title = `Recarga VIP WinQuina ${amountUsd} USD`;
      description = `Tiempo VIP estimado: ${formatVipDuration(minutes).days}d ${formatVipDuration(minutes).hours}h`;
      redirectPath = "/depositar";
    } else {
      const plan =
        planRaw === "weekly" ? "weekly" : planRaw === "annual" ? "annual" : "monthly";
      amountUsd = usdForPlan(plan);
      minutes = minutesForPlan(plan);
      const tag = plan === "weekly" ? "wk" : plan === "annual" ? "yr" : "mo";
      reference = `swvip-${String(userId).slice(0, 36)}-${tag}-${ts}-${suffix}`;
      title =
        plan === "weekly"
          ? "VIP Semanal WinQuina"
          : plan === "annual"
            ? "VIP Anual WinQuina"
            : "VIP Mensual WinQuina";
      description = `${minutes / (24 * 60)} días de membresía VIP`;
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
      idempotencyKey: reference.slice(0, 255),
    });

    try {
      await saveCheckout({
        paymentLinkId: link.id,
        reference,
        userId: String(userId),
        email: String(email).trim().toLowerCase(),
        minutes,
        amountUsd,
      });
    } catch (e) {
      logger.error("[landapay] saveCheckout failed", e);
      return res.status(500).json({
        error: "No se pudo registrar el checkout VIP",
      });
    }

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
      redirectUrl: frontendReturnUrl(redirectPath),
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
 * GET /api/payments/landapay/history?userId=
 * Historial de checkouts VIP del usuario.
 */
async function getLandapayHistory(req, res) {
  try {
    const userId = String(req.query?.userId || req.body?.userId || "").trim();
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: "userId inválido" });
    }
    const items = await listCheckoutsByUserId(userId, 40);
    return res.json({
      items: items.map((c) => ({
        paymentLinkId: c.paymentLinkId,
        paymentId: c.paymentId,
        reference: c.reference,
        amountUsd: c.amountUsd,
        minutes: c.minutes,
        duration: formatVipDuration(c.minutes),
        status: c.status,
        grantedAt: c.grantedAt,
        createdAt: c.createdAt,
      })),
    });
  } catch (e) {
    logger.error("[landapay] history error", e);
    return res.status(500).json({ error: "No se pudo cargar el historial" });
  }
}

/**
 * POST /api/payments/landapay/confirm-return
 * Una sola lectura a Landa. Si approved → otorga/suma VIP desde checkout local (idempotente).
 * El webhook hace lo mismo en paralelo; no hay polling en el cliente.
 */
async function confirmLandapayReturn(req, res) {
  try {
    if (!landapayConfigured()) {
      return res.status(503).json({ error: "Pagos no configurados" });
    }

    const paymentId = String(
      req.body?.paymentId || req.body?.payment_id || "",
    ).trim();
    const paymentLinkIdBody = String(
      req.body?.paymentLinkId || req.body?.payment_link_id || "",
    ).trim();
    const userId = String(req.body?.userId || "").trim();
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: "userId inválido" });
    }
    if (!paymentId) {
      return res.status(400).json({ error: "paymentId requerido" });
    }

    const payment = await retrievePaymentOnce(paymentId);
    const paymentLinkId =
      paymentLinkIdBody || String(payment?.paymentLink || "").trim();

    const stored =
      (paymentLinkId && (await findCheckoutByPaymentLinkId(paymentLinkId))) ||
      (await findCheckoutByPaymentId(paymentId));
    if (stored?.userId && stored.userId !== userId) {
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
    let grantError = null;

    if (status === "approved") {
      try {
        const r = await grantFromApprovedPayment(payment);
        if (r.error && !r.granted && !r.alreadyRedeemed) {
          grantError = r.error;
          logger.warn(`[landapay] confirm sin grant: ${r.error}`);
        } else {
          granted = r.granted;
          alreadyRedeemed = r.alreadyRedeemed;
          vipExpiresAt = r.vipExpiresAt;
          minutes = r.minutes || stored?.minutes || 0;
        }
      } catch (e) {
        logger.error("[landapay] grant failed on confirm-return", e);
        grantError = e.message || "Error al actualizar VIP";
      }
    }

    const done =
      status === "approved" &&
      (granted || alreadyRedeemed || Boolean(stored?.grantedAt));

    return res.json({
      status,
      paymentId: payment.id,
      paymentLinkId: paymentLinkId || payment.paymentLink || null,
      reference: stored?.reference || null,
      granted,
      alreadyRedeemed,
      waitingWebhook: false,
      vipExpiresAt,
      minutes,
      duration: formatVipDuration(minutes),
      paid: done,
      error: grantError || undefined,
      via: "confirm_oneshot",
    });
  } catch (e) {
    logger.error("[landapay] confirm-return error", e);
    return res.status(e.status && e.status < 500 ? e.status : 500).json({
      error: e.message || "Error al confirmar el pago",
      requestId: e.requestId || undefined,
    });
  }
}

async function landapayWebhook(req, res) {
  try {
    if (!landapayConfigured()) {
      return res.status(503).send("LANDAPAY_API_KEY missing");
    }
    const signature = req.get("Landa-Signature");
    const eventHeaderId = req.get("Landa-Event-Id");
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

    const eventId = String(event.id || eventHeaderId || "").trim();
    if (eventId) {
      const inserted = await markWebhookEventProcessed(eventId, event.type);
      if (!inserted) {
        logger.info(`[landapay] webhook event already processed id=${eventId}`);
        return res.sendStatus(200);
      }
    }

    if (event.type === "payment.approved") {
      const payment = event.data.object;
      try {
        const r = await grantFromApprovedPayment(payment);
        logger.info(
          `[landapay] webhook payment.approved pay=${payment.id} plink=${payment.paymentLink || "-"} granted=${r.granted} redeemed=${r.alreadyRedeemed} src=${r.source || "-"} err=${r.error || "-"}`,
        );
        if (r.error) {
          // 200 para no reintentar infinito si falta checkout; loguear para ops
          logger.error(`[landapay] webhook sin checkout: ${r.error}`);
        }
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
  getLandapayHistory,
  createLandapayVipCheckout,
  confirmLandapayReturn,
  landapayWebhook,
};
