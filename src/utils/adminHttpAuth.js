const { db } = require("../config/database");
const logger = require("./logger");
const {
  isAdminBearer,
  isAdminBearerAsync,
  getUserIdFromBearer,
  getUserIdFromBearerAsync,
  getEmailFromBearer,
  getEmailFromBearerAsync,
} = require("./jwtAdmin");
const { readUserProfile } = require("../services/firebaseAdmin");

function rowIsAdmin(row) {
  if (!row || typeof row !== "object") return false;
  const adminVal = row.is_admin ?? row.isAdmin ?? row.admin;
  if (adminVal === true || adminVal === 1) return true;
  if (typeof adminVal === "string") {
    return ["true", "t", "1", "yes", "si"].includes(adminVal.trim().toLowerCase());
  }
  return false;
}

function adminEmailsFromEnv() {
  const raw = [
    process.env.FACTORY_ADMIN_EMAILS,
    process.env.ADMIN_EMAILS,
    process.env.VITE_ADMIN_EMAILS,
  ]
    .filter(Boolean)
    .join(",");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
}

function stripBearer(authorizationHeader) {
  const raw = String(authorizationHeader || "").trim();
  return /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : "";
}

function firebaseDatabaseUrl() {
  return String(
    process.env.FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DB_URL || "",
  )
    .trim()
    .replace(/\/$/, "");
}

/**
 * Lee usuarios/{uid} con el ID token del propio usuario (no requiere service account).
 * Respeta rules: auth.uid == $uid.
 */
async function readUsuariosViaIdToken(uid, idToken) {
  const base = firebaseDatabaseUrl();
  if (!base || !uid || !idToken) return null;
  try {
    const url = `${base}/usuarios/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(idToken)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      logger.warn(`[adminHttpAuth] RTDB usuarios/${uid}: ${res.status} ${t.slice(0, 120)}`);
      return null;
    }
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch (e) {
    logger.warn(`[adminHttpAuth] RTDB REST: ${e.message || e}`);
    return null;
  }
}

/**
 * Admin si:
 * 1) claim admin en JWT
 * 2) email en FACTORY_ADMIN_EMAILS / ADMIN_EMAILS
 * 3) usuarios/{uid}.isAdmin en RTDB (Admin SDK o REST con ID token)
 * 4) pf_users.is_admin (legacy MatuDB, si responde)
 */
async function isAdminHttpRequest(req) {
  const auth = req.get("authorization");
  const token = stripBearer(auth);

  if (await isAdminBearerAsync(auth)) return true;
  if (isAdminBearer(auth)) return true;

  const email = ((await getEmailFromBearerAsync(auth)) || getEmailFromBearer(auth) || "")
    .trim()
    .toLowerCase();
  const adminEmails = adminEmailsFromEnv();
  if (email && adminEmails.has(email)) return true;

  // Dev local: si no configuraste FACTORY_ADMIN_EMAILS, cualquier sesión Firebase vale.
  const openAdmin =
    String(process.env.FACTORY_OPEN_ADMIN || "").toLowerCase() === "true" ||
    (adminEmails.size === 0 &&
      String(process.env.NODE_ENV || "development") !== "production" &&
      String(process.env.FACTORY_OPEN_ADMIN || "true").toLowerCase() !== "false");
  const userIdEarly = (await getUserIdFromBearerAsync(auth)) || getUserIdFromBearer(auth);
  if (openAdmin && userIdEarly) {
    logger.warn(
      `[adminHttpAuth] FACTORY_OPEN_ADMIN (dev): uid=${userIdEarly}. Define FACTORY_ADMIN_EMAILS en producción.`,
    );
    return true;
  }

  const userId = userIdEarly;
  if (userId) {
    let rtdb = await readUserProfile(userId);
    if (!rtdb && token) {
      rtdb = await readUsuariosViaIdToken(userId, token);
    }
    if (rowIsAdmin(rtdb)) return true;

    let row = null;
    try {
      const byId = await db.from("pf_users").select("is_admin").eq("id", userId).limit(1).maybeSingle();
      if (!byId.error) row = byId.data;
    } catch (e) {
      logger.warn(`adminHttpAuth pf_users by id: ${e.message || e}`);
    }
    if (!rowIsAdmin(row)) {
      try {
        const byFb = await db
          .from("pf_users")
          .select("is_admin")
          .eq("firebase_uid", userId)
          .limit(1)
          .maybeSingle();
        if (!byFb.error) row = byFb.data;
      } catch {
        /* MatuDB down */
      }
    }
    if (rowIsAdmin(row)) return true;
  }

  if (email) {
    try {
      const { data, error } = await db
        .from("pf_users")
        .select("is_admin")
        .ilike("email", email)
        .limit(1)
        .maybeSingle();
      if (!error && rowIsAdmin(data)) return true;
    } catch (e) {
      logger.warn(`adminHttpAuth pf_users by email: ${e.message || e}`);
    }
  }
  return false;
}

module.exports = { isAdminHttpRequest };
