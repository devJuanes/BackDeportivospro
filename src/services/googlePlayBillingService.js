const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { minutesForPlan } = require("../config/vipPricing");

/**
 * Validación server-side de compras Google Play.
 * No confía en minutos/plan enviados por el cliente: el productId verificado define el grant.
 *
 * Env:
 *  PLAY_BILLING_ENABLED=true
 *  PLAY_SERVICE_ACCOUNT_JSON=<json o ruta a archivo>
 *  PLAY_ALLOWED_PACKAGES=com.matubyte.MatuPicks,com.winquina.app
 *  PLAY_SKU_MONTHLY=matupicks_vip_monthly
 *  PLAY_SKU_WEEKLY=matupicks_vip_weekly
 *  PLAY_SKU_MAP={"com.winquina.app":{"monthly":"winquina_vip_monthly","weekly":"winquina_vip_weekly"}}
 */

function playBillingEnabled() {
  return String(process.env.PLAY_BILLING_ENABLED || "").toLowerCase() === "true";
}

function allowedPackages() {
  return String(process.env.PLAY_ALLOWED_PACKAGES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultSkuMonthly() {
  return String(process.env.PLAY_SKU_MONTHLY || "matupicks_vip_monthly").trim();
}

function defaultSkuWeekly() {
  return String(process.env.PLAY_SKU_WEEKLY || "matupicks_vip_weekly").trim();
}

function skuMap() {
  try {
    const raw = process.env.PLAY_SKU_MAP || "";
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** productId → { plan, minutes } */
function resolveProductGrant(packageName, productId) {
  const pid = String(productId || "").trim();
  const pkg = String(packageName || "").trim();
  const map = skuMap()[pkg] || {};
  const monthly = String(map.monthly || defaultSkuMonthly());
  const weekly = String(map.weekly || defaultSkuWeekly());

  if (pid === weekly) {
    return { plan: "weekly", minutes: minutesForPlan("weekly"), productId: pid };
  }
  if (pid === monthly) {
    return { plan: "monthly", minutes: minutesForPlan("monthly"), productId: pid };
  }
  // Aliases comunes
  if (/weekly|semana/i.test(pid)) {
    return { plan: "weekly", minutes: minutesForPlan("weekly"), productId: pid };
  }
  if (/monthly|mes|vip/i.test(pid)) {
    return { plan: "monthly", minutes: minutesForPlan("monthly"), productId: pid };
  }
  return null;
}

function loadServiceAccount() {
  const raw = String(process.env.PLAY_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("{")) return JSON.parse(raw);
    const filePath = path.isAbsolute(raw)
      ? raw
      : path.join(process.cwd(), raw);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    logger.error(`[play] service account invalid: ${e.message}`);
    return null;
  }
}

let cachedClient = null;

async function getAuthClient() {
  if (cachedClient) return cachedClient;
  const credentials = loadServiceAccount();
  if (!credentials) {
    const err = new Error(
      "PLAY_SERVICE_ACCOUNT_JSON no configurado (cuenta de servicio Play Console)",
    );
    err.status = 503;
    throw err;
  }
  // google-auth-library viene transitivo vía firebase-admin
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  cachedClient = await auth.getClient();
  return cachedClient;
}

/**
 * Verifica suscripción o producto one-time con Android Publisher API.
 * @returns {{ valid: boolean, productId: string, orderId?: string, expiryTimeMillis?: string, raw?: object }}
 */
async function verifyPurchase({ packageName, productId, purchaseToken }) {
  const pkg = String(packageName || "").trim();
  const pid = String(productId || "").trim();
  const token = String(purchaseToken || "").trim();

  if (!pkg || !pid || !token) {
    const err = new Error("packageName, productId y purchaseToken son requeridos");
    err.status = 400;
    throw err;
  }

  const allowed = allowedPackages();
  if (allowed.length && !allowed.includes(pkg)) {
    const err = new Error(`packageName no autorizado: ${pkg}`);
    err.status = 403;
    throw err;
  }

  const grant = resolveProductGrant(pkg, pid);
  if (!grant) {
    const err = new Error(`productId no reconocido: ${pid}`);
    err.status = 400;
    throw err;
  }

  const client = await getAuthClient();
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}`;

  // 1) Intentar como suscripción
  let subUrl = `${base}/purchases/subscriptions/${encodeURIComponent(pid)}/tokens/${encodeURIComponent(token)}`;
  let res = await client.request({ url: subUrl, method: "GET" }).catch((e) => e);

  if (res?.status === 200 && res.data) {
    const data = res.data;
    // paymentState 1 = received; 2 = free trial; 0 = pending
    const paymentState = Number(data.paymentState);
    const expiry = Number(data.expiryTimeMillis || 0);
    const valid =
      (paymentState === 1 || paymentState === 2 || data.acknowledgementState != null) &&
      (expiry === 0 || expiry > Date.now());
    return {
      valid: Boolean(valid),
      kind: "subscription",
      productId: pid,
      packageName: pkg,
      orderId: data.orderId || null,
      expiryTimeMillis: data.expiryTimeMillis || null,
      purchaseState: paymentState,
      grant,
      raw: data,
    };
  }

  // 2) Producto gestionado (one-time / consumible)
  const prodUrl = `${base}/purchases/products/${encodeURIComponent(pid)}/tokens/${encodeURIComponent(token)}`;
  res = await client.request({ url: prodUrl, method: "GET" }).catch((e) => e);
  if (res?.status === 200 && res.data) {
    const data = res.data;
    // purchaseState 0 = purchased
    const valid = Number(data.purchaseState) === 0;
    return {
      valid,
      kind: "product",
      productId: pid,
      packageName: pkg,
      orderId: data.orderId || null,
      expiryTimeMillis: null,
      purchaseState: data.purchaseState,
      grant,
      raw: data,
    };
  }

  const detail =
    res?.response?.data?.error?.message ||
    res?.message ||
    "Google Play rechazó el token";
  const err = new Error(detail);
  err.status = 400;
  throw err;
}

/**
 * Acknowledge suscripción (requerido por Play si no se hace en cliente).
 */
async function acknowledgeSubscription({ packageName, productId, purchaseToken }) {
  try {
    const client = await getAuthClient();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
    await client.request({ url, method: "POST", data: {} });
  } catch (e) {
    logger.warn(`[play] acknowledge failed: ${e.message}`);
  }
}

module.exports = {
  playBillingEnabled,
  allowedPackages,
  resolveProductGrant,
  verifyPurchase,
  acknowledgeSubscription,
};
