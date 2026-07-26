/**
 * Decodificación / verificación de Bearer (Firebase ID token preferido).
 * Si hay FIREBASE_SERVICE_ACCOUNT_*, se verifica la firma con Admin SDK.
 * Si no, se decodifica el payload (mismo riesgo que el gate MatuDB anterior).
 */
const { verifyIdToken, readUserProfile } = require("../services/firebaseAdmin");

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function stripBearer(authorizationHeader) {
  const raw = String(authorizationHeader || "").trim();
  return /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : "";
}

function roleFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.is_admin === true || payload.admin === true) return "admin";
  const direct = String(payload.role || "").toLowerCase();
  if (direct === "admin") return "admin";
  const app = payload.app_metadata;
  if (app && typeof app === "object" && typeof app.role === "string") {
    const r = String(app.role).toLowerCase();
    if (r === "admin") return "admin";
  }
  const um = payload.user_metadata;
  if (um && typeof um === "object" && typeof um.role === "string") {
    const r = String(um.role).toLowerCase();
    if (r === "admin") return "admin";
  }
  return direct;
}

function emailFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const mail = payload.email;
  if (typeof mail === "string" && mail.includes("@")) return mail.trim().toLowerCase();
  return null;
}

function userIdFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.user_id ?? payload.uid ?? payload.id ?? payload.sub;
  if (id == null || String(id).length === 0) return null;
  return String(id);
}

function expOk(payload) {
  const exp = Number(payload?.exp);
  if (Number.isFinite(exp) && exp * 1000 < Date.now()) return false;
  return true;
}

/** Cache corta por token para no pegarle a Firebase en cada request. */
const verifiedCache = new Map();
const CACHE_MS = 60_000;

async function resolveVerified(authorizationHeader) {
  const token = stripBearer(authorizationHeader);
  if (!token) return null;
  const hit = verifiedCache.get(token);
  if (hit && hit.until > Date.now()) return hit.value;

  const verified = await verifyIdToken(token);
  let value = null;
  if (verified?.uid) {
    value = {
      uid: verified.uid,
      email: verified.email,
      admin: Boolean(verified.admin),
      verified: true,
    };
  } else {
    const payload = decodeJwtPayload(token);
    if (payload && expOk(payload)) {
      value = {
        uid: userIdFromPayload(payload),
        email: emailFromPayload(payload),
        admin: roleFromPayload(payload) === "admin",
        verified: false,
      };
    }
  }

  verifiedCache.set(token, { until: Date.now() + CACHE_MS, value });
  return value;
}

function getEmailFromBearer(authorizationHeader) {
  const token = stripBearer(authorizationHeader);
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload || !expOk(payload)) return null;
  return emailFromPayload(payload);
}

function getUserIdFromBearer(authorizationHeader) {
  const token = stripBearer(authorizationHeader);
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload || !expOk(payload)) return null;
  return userIdFromPayload(payload);
}

function isAdminBearer(authorizationHeader) {
  const token = stripBearer(authorizationHeader);
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload || !expOk(payload)) return false;
  return roleFromPayload(payload) === "admin";
}

async function getEmailFromBearerAsync(authorizationHeader) {
  const v = await resolveVerified(authorizationHeader);
  return v?.email || getEmailFromBearer(authorizationHeader);
}

async function getUserIdFromBearerAsync(authorizationHeader) {
  const v = await resolveVerified(authorizationHeader);
  return v?.uid || getUserIdFromBearer(authorizationHeader);
}

async function isAdminBearerAsync(authorizationHeader) {
  const v = await resolveVerified(authorizationHeader);
  if (v?.admin) return true;
  if (v?.uid) {
    const profile = await readUserProfile(v.uid);
    if (profile && (profile.isAdmin === true || profile.is_admin === true)) return true;
  }
  return isAdminBearer(authorizationHeader);
}

module.exports = {
  decodeJwtPayload,
  getEmailFromBearer,
  getUserIdFromBearer,
  isAdminBearer,
  getEmailFromBearerAsync,
  getUserIdFromBearerAsync,
  isAdminBearerAsync,
  resolveVerified,
};
