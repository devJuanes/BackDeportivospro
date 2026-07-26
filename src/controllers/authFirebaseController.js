const {
  resolveVerified,
} = require("../utils/jwtAdmin");
const { upsertUserProfile, ensureInitialized } = require("../services/firebaseAdmin");
const logger = require("../utils/logger");

/**
 * Espejo del perfil Firebase RTDB desde el cliente (login/registro).
 * POST /api/auth/firebase/sync  Authorization: Bearer <Firebase ID token>
 */
async function postFirebaseSync(req, res) {
  try {
    const session = await resolveVerified(req.get("authorization"));
    if (!session?.uid) {
      return res.status(401).json({ error: "Sesión Firebase requerida." });
    }

    const body = req.body || {};
    const profile = {
      email: String(body.email || session.email || "").trim().toLowerCase(),
      name: String(body.name || "").trim() || "Usuario",
      phone: body.phone ? String(body.phone).trim() : null,
      isVip: Boolean(body.isVip),
      isAdmin: Boolean(body.isAdmin),
      vipExpiresAt: body.vipExpiresAt || null,
      vipTrialClaimedAt: body.vipTrialClaimedAt || null,
    };

    if (!ensureInitialized()) {
      // Sin service account: el cliente ya escribió RTDB; OK parcial.
      return res.json({ ok: true, mirrored: false, uid: session.uid });
    }

    const ok = await upsertUserProfile(session.uid, profile);
    if (!ok) {
      logger.warn(`[auth-firebase] No se pudo espejar RTDB para ${session.uid}`);
      return res.json({ ok: true, mirrored: false, uid: session.uid });
    }
    return res.json({ ok: true, mirrored: true, uid: session.uid });
  } catch (e) {
    logger.error("[auth-firebase] sync", e);
    return res.status(500).json({ error: e.message || "Error sync Firebase" });
  }
}

/**
 * Perfil actual desde RTDB (admin/SDK) o claims del token.
 * GET /api/auth/firebase/me
 */
async function getFirebaseMe(req, res) {
  try {
    const session = await resolveVerified(req.get("authorization"));
    if (!session?.uid) {
      return res.status(401).json({ error: "Sesión Firebase requerida." });
    }
    const { readUserProfile } = require("../services/firebaseAdmin");
    const profile = (await readUserProfile(session.uid)) || {};
    return res.json({
      id: session.uid,
      email: profile.email || session.email,
      name: profile.name || "Usuario",
      isVip: Boolean(profile.isVip),
      isAdmin: Boolean(profile.isAdmin) || Boolean(session.admin),
      vipExpiresAt: profile.vipExpiresAt || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Error" });
  }
}

module.exports = { postFirebaseSync, getFirebaseMe };
