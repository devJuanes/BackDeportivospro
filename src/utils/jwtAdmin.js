/**
 * Decodificación JWT sin verificar firma (solo gate de rol para acciones internas).
 * En producción el token lo emite MatuDB Auth; la verificación criptográfica queda en el emisor.
 */
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

function roleFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.is_admin === true) return "admin";
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

/** Usuario autenticado (MatuDB JWT): `id` o `sub`, exp no vencido. */
function getUserIdFromBearer(authorizationHeader) {
  const raw = String(authorizationHeader || "").trim();
  const token = /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && exp * 1000 < Date.now()) return null;
  const id = payload.id ?? payload.sub;
  if (id == null || String(id).length === 0) return null;
  return String(id);
}

/** Bearer admin + exp no vencido. */
function isAdminBearer(authorizationHeader) {
  const raw = String(authorizationHeader || "").trim();
  const token = /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && exp * 1000 < Date.now()) return false;
  return roleFromPayload(payload) === "admin";
}

module.exports = {
  decodeJwtPayload,
  getUserIdFromBearer,
  isAdminBearer,
};
