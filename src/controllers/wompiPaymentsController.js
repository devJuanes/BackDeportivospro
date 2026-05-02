const crypto = require("crypto");
const logger = require("../utils/logger");
const {
  buildWebCheckoutUrl,
  parsePfVipUserIdFromReference,
  parsePfVipMetaFromReference,
} = require("../services/wompiService");
const { listWompiRedemptionsByUserId } = require("../models/wompiVipRedemptionModel");
const { getUserIdFromBearer } = require("../utils/jwtAdmin");
const { fetchWompiTransaction } = require("../services/wompiRestService");
const { grantVipAfterApprovedPayment } = require("../services/vipSubscriptionService");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PLAN_LABEL_BY_TAG = { wk: "Semanal", mo: "Mensual", yr: "Anual" };

/** 20.000 COP/mes en centavos (100 centavos = 1 COP en API Wompi). */
const DEFAULT_MONTHLY_CENTS = 2_000_000;
/** Anual con descuento ~17% vs 12× mensual (240k → 200k COP). */
const DEFAULT_ANNUAL_CENTS = 20_000_000;
/** Semanal (~7k COP): más caro que prorratear el mensual para favorecer plan mensual. */
const DEFAULT_WEEKLY_CENTS = 700_000;

let warnedEnvMismatch = false;

function warnWompiEnvMismatchOnce() {
  if (warnedEnvMismatch) return;
  warnedEnvMismatch = true;
  const pub = process.env.WOMPI_PUBLIC_KEY || "";
  const isTest = pub.startsWith("pub_test_");
  const isProd = pub.startsWith("pub_prod_");
  const nodeProd = process.env.NODE_ENV === "production";
  const wompiSandbox = (process.env.WOMPI_ENV || "").toLowerCase() === "sandbox";
  if (!nodeProd && isProd) {
    logger.warn(
      "[wompi] Estás en desarrollo (NODE_ENV≠production) pero WOMPI_PUBLIC_KEY es de PRODUCCIÓN. En local usa pub_test_ / test_integrity_.",
    );
  }
  if (nodeProd && isTest) {
    logger.warn(
      "[wompi] NODE_ENV=production pero WOMPI_PUBLIC_KEY es de PRUEBA. En producción usa pub_prod_ / prod_integrity_.",
    );
  }
  if (wompiSandbox && isProd) {
    logger.warn("[wompi] WOMPI_ENV=sandbox no coincide con llave pub_prod_; usa llaves test en sandbox.");
  }
}

function monthlyAmountCents() {
  const explicit = Number.parseInt(process.env.WOMPI_VIP_MONTHLY_AMOUNT_CENTS || "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const legacy = Number.parseInt(process.env.WOMPI_VIP_AMOUNT_CENTS || "", 10);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;
  return DEFAULT_MONTHLY_CENTS;
}

function annualAmountCents() {
  const v = Number.parseInt(process.env.WOMPI_VIP_ANNUAL_AMOUNT_CENTS || "", 10);
  if (Number.isFinite(v) && v > 0) return v;
  return DEFAULT_ANNUAL_CENTS;
}

function weeklyAmountCents() {
  const v = Number.parseInt(process.env.WOMPI_VIP_WEEKLY_AMOUNT_CENTS || "", 10);
  if (Number.isFinite(v) && v > 0) return v;
  return DEFAULT_WEEKLY_CENTS;
}

function wompiConfigured() {
  return Boolean(process.env.WOMPI_PUBLIC_KEY && process.env.WOMPI_INTEGRITY_SECRET);
}

function amountForPlan(plan) {
  if (plan === "annual") return annualAmountCents();
  if (plan === "weekly") return weeklyAmountCents();
  return monthlyAmountCents();
}

function publicRedirectBase() {
  return (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || "").replace(/\/$/, "");
}

function mergeReturnQuery(baseUrl) {
  try {
    const u = new URL(baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`);
    u.searchParams.set("wompi_return", "1");
    return u.toString();
  } catch {
    return null;
  }
}

function hostBlockedForWompiRedirect(host) {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h.endsWith(".local") ||
    /^192\.168\.\d+\.\d+$/.test(h) ||
    /^10\.\d+\.\d+\.\d+$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)
  );
}

/**
 * Tras pagar, Wompi redirige al cliente agregando `?id=<transaction_id>` (widget/checkout).
 * Sin URL pública válida, muchos quedan en la pantalla de comprobante sin “volver al comercio”.
 *
 * `WOMPI_REDIRECT_URL`: URL completa de retorno (ej. https://tu-dominio.com/predictions/vip); tiene prioridad.
 */
function wompiRedirectUrlSafe() {
  const pub = process.env.WOMPI_PUBLIC_KEY || "";
  const isProdKey = pub.startsWith("pub_prod_");
  const explicit = (process.env.WOMPI_REDIRECT_URL || "").trim();
  if (explicit) {
    const merged = mergeReturnQuery(explicit);
    if (merged) {
      try {
        const u = new URL(merged);
        if (!hostBlockedForWompiRedirect(u.hostname)) return merged;
        if (isProdKey) {
          logger.warn(
            "[wompi] WOMPI_REDIRECT_URL local/privado omitido: con llave pub_prod_ Wompi/CloudFront lo bloquea.",
          );
          return undefined;
        }
        if (process.env.WOMPI_ALLOW_LOCAL_REDIRECT === "true") return merged;
        logger.warn(
          "[wompi] WOMPI_REDIRECT_URL local/privado omitido. Usa HTTPS público (dominio o túnel) para evitar 403 en checkout.",
        );
        return undefined;
      } catch {
        logger.warn("[wompi] WOMPI_REDIRECT_URL inválido.");
        return undefined;
      }
    }
    logger.warn("[wompi] WOMPI_REDIRECT_URL inválido.");
  }

  const raw = publicRedirectBase();
  if (!raw) return undefined;
  let urlString = raw;
  if (!/^https?:\/\//i.test(urlString)) urlString = `https://${urlString}`;
  try {
    const u = new URL(urlString);
    if (hostBlockedForWompiRedirect(u.hostname)) {
      if (isProdKey) {
        logger.warn(
          "[wompi] redirect-url local/privado omitido: con llave pub_prod_ Wompi/CloudFront lo bloquea. Usa HTTPS público (dominio o túnel).",
        );
        return undefined;
      }
      if (process.env.WOMPI_ALLOW_LOCAL_REDIRECT === "true") {
        return mergeReturnQuery(`${raw}/predictions/vip`) || `${raw}/predictions/vip?wompi_return=1`;
      }
      logger.warn(
        "[wompi] redirect-url omitido (host local/privado). Configura WOMPI_REDIRECT_URL (https/ngrok) o WOMPI_ALLOW_LOCAL_REDIRECT=true si Wompi lo acepta.",
      );
      return undefined;
    }
    return mergeReturnQuery(`${raw}/predictions/vip`) || `${raw}/predictions/vip?wompi_return=1`;
  } catch {
    logger.warn("[wompi] APP_PUBLIC_URL inválido; redirect-url omitido.");
    return undefined;
  }
}

function redirectConfiguredForClient() {
  return Boolean(wompiRedirectUrlSafe());
}

function savingsAnnualVsMonthlyPercent() {
  const m12 = monthlyAmountCents() * 12;
  const y = annualAmountCents();
  if (m12 <= 0 || y >= m12) return 0;
  return Math.round(((m12 - y) / m12) * 100);
}

/** Cuánto más sale 4× semanal vs 1 mensual (para mostrar “mejor mensual”). */
function weeklyPremiumVsMonthlyPercent() {
  const w = weeklyAmountCents();
  const m = monthlyAmountCents();
  if (m <= 0 || w <= 0) return 0;
  const w4 = w * 4;
  if (w4 <= m) return 0;
  return Math.round(((w4 - m) / m) * 100);
}

/**
 * POST /api/payments/wompi/checkout
 * Body: { userId, email, fullName?, phone?, plan?: 'weekly' | 'monthly' | 'annual' }
 */
async function createVipCheckout(req, res) {
  try {
    warnWompiEnvMismatchOnce();
    if (!wompiConfigured()) {
      return res.status(503).json({
        error: "Pagos no configurados",
        hint:
          "Define WOMPI_PUBLIC_KEY e WOMPI_INTEGRITY_SECRET (pub_test_/test_integrity_ en local, pub_prod_/prod_integrity_ en producción).",
      });
    }

    const planRaw = req.body?.plan;
    const plan =
      planRaw === "annual" ? "annual" : planRaw === "weekly" ? "weekly" : "monthly";
    const amt = amountForPlan(plan);
    if (!amt || amt <= 0) {
      return res.status(503).json({ error: "Montos VIP inválidos en env" });
    }

    const { userId, email, fullName, phone } = req.body || {};
    if (!userId || !UUID_RE.test(String(userId))) {
      return res.status(400).json({ error: "userId UUID requerido" });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "email válido requerido" });
    }

    const suffix = crypto.randomBytes(6).toString("hex");
    const tag = plan === "annual" ? "yr" : plan === "weekly" ? "wk" : "mo";
    const reference = `pfvip-${userId}-${tag}-${Date.now()}-${suffix}`;

    const redirectUrl = wompiRedirectUrlSafe();

    const url = buildWebCheckoutUrl({
      publicKey: process.env.WOMPI_PUBLIC_KEY,
      amountInCents: amt,
      currency: "COP",
      reference,
      integritySecret: process.env.WOMPI_INTEGRITY_SECRET,
      redirectUrl,
      customerEmail: email.trim(),
      customerFullName: typeof fullName === "string" ? fullName.trim() : undefined,
      customerPhone: typeof phone === "string" ? phone.trim() : undefined,
    });

    logger.info(`[wompi] checkout plan=${plan} ref=${reference} user=${userId} cents=${amt}`);

    return res.json({
      url,
      reference,
      amountInCents: amt,
      currency: "COP",
      plan,
    });
  } catch (e) {
    logger.error("[wompi] checkout error", e);
    return res.status(500).json({ error: "No se pudo iniciar el pago" });
  }
}

/**
 * POST /api/payments/wompi/confirm-return
 * Valida transacción en Wompi y activa VIP (idempotente por transaction id).
 * Body: { transactionId: string, userId: string }
 */
async function confirmWompiReturn(req, res) {
  try {
    warnWompiEnvMismatchOnce();
    if (!wompiConfigured()) {
      return res.status(503).json({ error: "Pagos no configurados" });
    }

    const transactionId = req.body?.transactionId;
    const userId = req.body?.userId;
    if (!userId || !UUID_RE.test(String(userId))) {
      return res.status(400).json({ error: "userId UUID requerido" });
    }

    const pub = process.env.WOMPI_PUBLIC_KEY;
    const fetched = await fetchWompiTransaction(pub, transactionId);
    if (!fetched.ok || !fetched.data) {
      return res.status(fetched.status >= 400 ? fetched.status : 502).json({
        error: typeof fetched.error === "string" ? fetched.error : "No se pudo consultar la transacción",
      });
    }

    const tx = fetched.data;
    const status = tx.status ? String(tx.status).toUpperCase() : "";
    const reference = tx.reference ? String(tx.reference) : "";
    const txUser = parsePfVipUserIdFromReference(reference);

    if (!reference || txUser !== userId) {
      return res.status(403).json({
        error: "Esta transacción no corresponde a tu cuenta.",
        status,
        reference: reference || undefined,
      });
    }

    let granted = false;
    let vipExpiresAt = null;
    let alreadyRedeemed = false;

    if (status === "APPROVED" && process.env.WOMPI_WEBHOOK_GRANT_VIP !== "false") {
      const idStr = tx.id != null ? String(tx.id) : String(transactionId);
      try {
        const r = await grantVipAfterApprovedPayment(userId, reference, idStr);
        granted = r.granted;
        vipExpiresAt = r.vipExpiresAt;
        alreadyRedeemed = r.alreadyRedeemed;
      } catch {
        return res.status(500).json({ error: "No se pudo actualizar el VIP en base de datos." });
      }
    }

    return res.json({
      status,
      reference,
      transactionId: tx.id != null ? String(tx.id) : String(transactionId),
      statusMessage: tx.status_message ? String(tx.status_message) : undefined,
      granted,
      vipExpiresAt,
      alreadyRedeemed,
    });
  } catch (e) {
    logger.error("[wompi] confirm-return error", e);
    return res.status(500).json({ error: "Error al confirmar el pago" });
  }
}

function getTransactionFromWebhookBody(body) {
  if (!body || typeof body !== "object") return null;
  const data = body.data && typeof body.data === "object" ? body.data : body;
  const tx = data.transaction && typeof data.transaction === "object" ? data.transaction : data;
  if (!tx || typeof tx !== "object") return null;
  return tx;
}

/**
 * POST /api/payments/wompi/webhook
 */
async function wompiWebhook(req, res) {
  try {
    const tx = getTransactionFromWebhookBody(req.body);
    const status = tx?.status ? String(tx.status).toUpperCase() : "";
    const reference = tx?.reference ? String(tx.reference) : "";
    const txId =
      tx?.id != null
        ? String(tx.id)
        : req.body?.data?.id != null
          ? String(req.body.data.id)
          : req.body?.id != null
            ? String(req.body.id)
            : "";

    logger.info(`[wompi] webhook status=${status || "?"} ref=${reference || "?"} tx=${txId || "?"}`);

    if (status === "APPROVED" && reference) {
      const userId = parsePfVipUserIdFromReference(reference);
      if (userId && process.env.WOMPI_WEBHOOK_GRANT_VIP !== "false") {
        try {
          const r = await grantVipAfterApprovedPayment(userId, reference, txId || null);
          logger.info(
            `[wompi] webhook VIP user=${userId} granted=${r.granted} redeemed=${r.alreadyRedeemed}`,
          );
        } catch (sqlErr) {
          logger.error("[wompi] no se pudo otorgar VIP (MatuDB)", sqlErr);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    logger.error("[wompi] webhook error", e);
    return res.status(200).json({ received: true });
  }
}

/**
 * GET /api/payments/wompi/my-redemptions
 * Historial de cobros VIP Wompi del usuario del Bearer (MatuDB JWT).
 */
async function getMyWompiRedemptions(req, res, next) {
  try {
    const userId = getUserIdFromBearer(req.get("authorization"));
    if (!userId) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const rows = await listWompiRedemptionsByUserId(userId, 30);
    const redemptions = rows.map((r) => {
      const ref = r.reference != null ? String(r.reference) : "";
      const meta = parsePfVipMetaFromReference(ref);
      const planTag = meta?.planTag && PLAN_LABEL_BY_TAG[meta.planTag] ? meta.planTag : "mo";
      return {
        reference: ref,
        wompiTransactionId: r.wompi_transaction_id != null ? String(r.wompi_transaction_id) : null,
        createdAt: r.created_at != null ? String(r.created_at) : "",
        planTag,
        planLabel: PLAN_LABEL_BY_TAG[planTag] || PLAN_LABEL_BY_TAG.mo,
      };
    });
    return res.json({ redemptions });
  } catch (e) {
    logger.error("[wompi] my-redemptions", e);
    return next(e);
  }
}

function getWompiStatus(req, res) {
  warnWompiEnvMismatchOnce();
  const pub = process.env.WOMPI_PUBLIC_KEY || "";
  const monthly = monthlyAmountCents();
  const annual = annualAmountCents();
  const weekly = weeklyAmountCents();
  const configured = wompiConfigured() && monthly > 0 && annual > 0 && weekly > 0;
  const wompiSandbox = pub.startsWith("pub_test_");
  const savingsPct = savingsAnnualVsMonthlyPercent();
  const weeklyPremiumPct = weeklyPremiumVsMonthlyPercent();

  return res.json({
    enabled: configured,
    environment: wompiSandbox ? "sandbox" : pub.startsWith("pub_prod_") ? "production" : "unknown",
    redirectConfigured: redirectConfiguredForClient(),
    plans: {
      weekly: {
        id: "weekly",
        amountInCents: weekly,
        label: "Semanal",
        premiumPercentVsMonthlyProrated: weeklyPremiumPct,
      },
      monthly: {
        id: "monthly",
        amountInCents: monthly,
        label: "Mensual",
      },
      annual: {
        id: "annual",
        amountInCents: annual,
        label: "Anual",
        savingsPercentVsMonthly: savingsPct,
      },
    },
    currency: "COP",
    methodsHint:
      "Tras pagar, Wompi te redirige con ?id=<transacción>. Configura WOMPI_REDIRECT_URL o APP_PUBLIC_URL https para volver al sitio y confirmar el VIP.",
  });
}

module.exports = {
  createVipCheckout,
  confirmWompiReturn,
  wompiWebhook,
  getWompiStatus,
  getMyWompiRedemptions,
};
