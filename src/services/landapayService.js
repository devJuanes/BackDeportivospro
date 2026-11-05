const { landapay, SignatureVerificationError } = require("landapay");
const logger = require("../utils/logger");

function landapayConfigured() {
  return Boolean(String(process.env.LANDAPAY_API_KEY || "").trim());
}

function assertConfigured() {
  if (!landapayConfigured()) {
    const err = new Error("LANDAPAY_API_KEY no configurada");
    err.code = "LANDAPAY_NOT_CONFIGURED";
    throw err;
  }
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
  assertConfigured();
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
  assertConfigured();
  return landapay.payments.retrieve(String(paymentId));
}

function constructWebhookEvent(rawBody, signatureHeader) {
  assertConfigured();
  return landapay.webhooks.constructEvent(rawBody, signatureHeader);
}

function isLivemode() {
  return Boolean(landapay.livemode);
}

module.exports = {
  landapayConfigured,
  createVipPaymentLink,
  retrievePayment,
  constructWebhookEvent,
  isLivemode,
  SignatureVerificationError,
};
