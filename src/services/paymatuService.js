const logger = require("../utils/logger");

function paymatuBaseUrl() {
  return String(process.env.PAYMATUBYTE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function paymatuApiKey() {
  return String(process.env.PAYMATUBYTE_API_KEY || "").trim();
}

function paymatuConfigured() {
  return Boolean(paymatuApiKey());
}

async function paymatuFetch(path, { method = "GET", body } = {}) {
  const key = paymatuApiKey();
  if (!key) {
    const err = new Error("PAYMATUBYTE_API_KEY no configurada");
    err.code = "PAYMATU_NOT_CONFIGURED";
    throw err;
  }
  const url = `${paymatuBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json?.error ||
      json?.message ||
      json?.data?.message ||
      `PayMatuByte HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * Crea link Bold vía PayMatuByte (dev = sandbox).
 * amountUsd: número en dólares (se convierte a COP en PayMatuByte).
 */
async function createPaymentLink({
  amountUsd,
  reference,
  description,
  productId,
  returnUrl,
}) {
  const base = paymatuBaseUrl();
  const forceSandbox =
    /localhost|127\.0\.0\.1/i.test(base) ||
    String(process.env.PAYMATUBYTE_ENV || "").toLowerCase() === "sandbox";
  const body = {
    reference,
    description: description || "VIP SuperWin",
    currency: "USD",
    amount: Number(amountUsd),
    environment: forceSandbox ? "sandbox" : "live",
  };
  if (productId) body.productId = productId;
  if (returnUrl) body.returnUrl = returnUrl;

  logger.info(
    `[paymatu] create link ref=${reference} usd=${amountUsd} product=${productId || "-"}`,
  );
  return paymatuFetch("/v1/payment", { method: "POST", body });
}

async function getPaymentStatus(referenceOrLinkId) {
  return paymatuFetch(`/v1/payment/link/${encodeURIComponent(referenceOrLinkId)}`);
}

module.exports = {
  paymatuConfigured,
  paymatuBaseUrl,
  createPaymentLink,
  getPaymentStatus,
};
