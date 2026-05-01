const crypto = require("crypto");

/**
 * Firma de integridad Web Checkout Wompi (orden estricto).
 * @see https://docs.wompi.co/en/docs/colombia/widget-checkout-web/
 */
function integritySignature(reference, amountInCents, currency, integritySecret) {
  const concat = `${reference}${amountInCents}${currency}${integritySecret}`;
  return crypto.createHash("sha256").update(concat, "utf8").digest("hex");
}

/** Host de checkout (mismo para sandbox/prod; distinguen las llaves pub_test_* vs pub_prod_*). */
function defaultCheckoutOrigin() {
  return "https://checkout.wompi.co/p/";
}

/**
 * Construye URL GET al Web Checkout de Wompi (todos los medios habilitados en el panel del comercio:
 * tarjetas, PSE, Nequi, Bancolombia a la mano, llaves Bre-B / transferencias, etc.).
 */
function buildWebCheckoutUrl({
  publicKey,
  amountInCents,
  currency,
  reference,
  integritySecret,
  redirectUrl,
  customerEmail,
  customerFullName,
  customerPhone,
}) {
  const base = (process.env.WOMPI_CHECKOUT_URL || defaultCheckoutOrigin()).replace(/\/?$/, "/");
  const url = new URL(base.includes("/p") ? base : `${base}p/`);
  const sig = integritySignature(reference, amountInCents, currency, integritySecret);
  const params = [];
  const addParam = (key, value) => {
    if (value == null) return;
    const str = String(value);
    if (!str) return;
    params.push(`${key}=${encodeURIComponent(str)}`);
  };

  // Wompi espera estos nombres con ":" literal; CloudFront puede bloquear %3A en el nombre.
  addParam("public-key", publicKey);
  addParam("currency", currency);
  addParam("amount-in-cents", amountInCents);
  addParam("reference", reference);
  addParam("signature:integrity", sig);
  addParam("redirect-url", redirectUrl);

  // Igual que en MatuCashBakend: customer-data:* es opcional y puede gatillar bloqueos
  // por saneamiento/intermediarios; se omite en el checkout URL.
  void customerEmail;
  void customerFullName;
  void customerPhone;

  return `${url.origin}${url.pathname}?${params.join("&")}`;
}

const PFVIP_UUID_SEG =
  "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";

/** Referencias: pfvip-{uuid}-wk-|mo-|yr-{ts}-… */
function parsePfVipMetaFromReference(reference) {
  if (!reference || typeof reference !== "string") return null;
  const trimmed = reference.trim();
  const tagged = new RegExp(`^pfvip-${PFVIP_UUID_SEG}-(wk|mo|yr)-`, "i").exec(trimmed);
  if (tagged) return { userId: tagged[1], planTag: tagged[2].toLowerCase() };
  const legacy = new RegExp(`^pfvip-${PFVIP_UUID_SEG}-`, "i").exec(trimmed);
  if (legacy) return { userId: legacy[1], planTag: "mo" };
  return null;
}

function parsePfVipUserIdFromReference(reference) {
  const meta = parsePfVipMetaFromReference(reference);
  return meta?.userId ?? null;
}

module.exports = {
  integritySignature,
  buildWebCheckoutUrl,
  parsePfVipMetaFromReference,
  parsePfVipUserIdFromReference,
};
