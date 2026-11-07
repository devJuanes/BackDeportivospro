const { Landapay, SignatureVerificationError } = require("landapay");
const logger = require("../utils/logger");

let client = null;

function readApiKey() {
  return String(process.env.LANDAPAY_API_KEY || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function landapayConfigured() {
  const key = readApiKey();
  return key.startsWith("lp_sk_test_") || key.startsWith("lp_sk_live_");
}

function getClient() {
  const apiKey = readApiKey();
  if (!apiKey.startsWith("lp_sk_test_") && !apiKey.startsWith("lp_sk_live_")) {
    const err = new Error(
      "LANDAPAY_API_KEY inválida en el servidor. Debe empezar por lp_sk_test_ o lp_sk_live_.",
    );
    err.code = "LANDAPAY_BAD_KEY";
    err.status = 400;
    throw err;
  }
  if (!client) {
    client = new Landapay({
      apiKey,
      webhookSecret: String(process.env.LANDAPAY_WEBHOOK_SECRET || "")
        .trim()
        .replace(/^["']|["']$/g, "") || undefined,
    });
  }
  return client;
}

/**
 * Crea link de pago Landa Pay.
 * amountUsd → centavos USD (currency USD; Landa cobra en COP con tasa del día).
 * @see https://docs.landapay.co/links-de-pago
 */
async function createVipPaymentLink({
  title,
  description,
  amountUsd,
  redirectUrl,
  metadata,
  idempotencyKey,
}) {
  const landapay = getClient();
  const amountCents = Math.max(1, Math.round(Number(amountUsd) * 100));
  const link = await landapay.paymentLinks.create(
    {
      title,
      description: description || null,
      amount: amountCents,
      currency: "USD",
      redirectUrl: redirectUrl || null,
      metadata: metadata || {},
    },
    idempotencyKey ? { idempotencyKey: String(idempotencyKey).slice(0, 255) } : undefined,
  );
  logger.info(
    `[landapay] link created id=${link.id} usd=${amountUsd} cents=${amountCents} livemode=${link.livemode}`,
  );
  return link;
}

async function retrievePayment(paymentId) {
  return getClient().payments.retrieve(String(paymentId));
}

async function retrievePaymentLink(paymentLinkId) {
  return getClient().paymentLinks.retrieve(String(paymentLinkId));
}

function constructWebhookEvent(rawBody, signatureHeader) {
  return getClient().webhooks.constructEvent(rawBody, signatureHeader);
}

function isLivemode() {
  return readApiKey().startsWith("lp_sk_live_");
}

module.exports = {
  landapayConfigured,
  createVipPaymentLink,
  retrievePayment,
  retrievePaymentLink,
  constructWebhookEvent,
  isLivemode,
  SignatureVerificationError,
};
