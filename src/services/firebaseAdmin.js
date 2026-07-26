const admin = require("firebase-admin");

let initialized = false;

function parseServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (raw) return JSON.parse(raw);
  const b64 = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "").trim();
  if (!b64) return null;
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function ensureInitialized() {
  if (initialized) return true;
  const account = parseServiceAccount();
  if (!account) return false;
  if (!admin.apps.length) {
    const databaseURL = String(process.env.FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DB_URL || "").trim();
    admin.initializeApp({
      credential: admin.credential.cert(account),
      projectId: process.env.FIREBASE_PROJECT_ID || account.project_id,
      ...(databaseURL ? { databaseURL } : {}),
    });
  }
  initialized = true;
  return true;
}

function getAdmin() {
  if (!ensureInitialized()) return null;
  return admin;
}

/**
 * Verifica un Firebase ID token.
 * @returns {Promise<null | { uid: string, email: string | null, name: string | null, raw: object }>}
 */
async function verifyIdToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const a = getAdmin();
  if (!a) return null;
  try {
    const decoded = await a.auth().verifyIdToken(raw);
    return {
      uid: String(decoded.uid || decoded.user_id || decoded.sub || ""),
      email: typeof decoded.email === "string" ? decoded.email.toLowerCase() : null,
      name: typeof decoded.name === "string" ? decoded.name : null,
      admin: decoded.admin === true || decoded.role === "admin",
      raw: decoded,
    };
  } catch {
    return null;
  }
}

async function upsertUserProfile(uid, profile) {
  const a = getAdmin();
  if (!a || !uid) return false;
  if (!a.apps.length) return false;
  try {
    const db = a.database();
    const ref = db.ref(`usuarios/${uid}`);
    // Solo merge: no reemplazar el nodo (preserva campos legacy de la RTDB existente).
    const patch = {
      ...Object.fromEntries(
        Object.entries(profile || {}).filter(([, v]) => v !== undefined),
      ),
      updatedAt: new Date().toISOString(),
    };
    const snap = await ref.get();
    if (!snap.exists() || !snap.val()?.createdAt) {
      patch.createdAt = profile.createdAt || new Date().toISOString();
    }
    await ref.update(patch);
    return true;
  } catch (e) {
    return false;
  }
}

async function readUserProfile(uid) {
  const a = getAdmin();
  if (!a || !uid) return null;
  try {
    const snap = await a.database().ref(`usuarios/${uid}`).get();
    return snap.exists() ? snap.val() : null;
  } catch {
    return null;
  }
}

module.exports = {
  ensureInitialized,
  getAdmin,
  verifyIdToken,
  upsertUserProfile,
  readUserProfile,
  admin,
};
