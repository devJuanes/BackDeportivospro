const {
  sendVerificationCode,
  verifyCode,
  claimVipTrial,
  getEmailVerificationStatus,
  VIP_TRIAL_DAYS,
} = require("../services/emailOtpService");
const passwordReset = require("../services/passwordResetService");
const googleOauth = require("../services/googleOauthService");
const { getUserIdFromBearer, getEmailFromBearer } = require("../utils/jwtAdmin");
const logger = require("../utils/logger");

function getBearerUser(req) {
  const auth = req.headers.authorization || "";
  const id = getUserIdFromBearer(auth);
  const email = getEmailFromBearer(auth);
  if (!id || !email) return null;
  return { id, email };
}

function getEmailVerification(req, res) {
  return res.json({ ok: true, ...getEmailVerificationStatus() });
}

async function postSendCode(req, res) {
  try {
    const email = req.body?.email;
    const result = await sendVerificationCode(email);
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth-trial] sendCode", e);
    else logger.warn(`[auth-trial] sendCode ${status}: ${e.message}`);
    return res.status(status).json({
      error: e.message || "Error al enviar código",
      code: e.code,
      emailVerification: getEmailVerificationStatus(),
    });
  }
}

async function postVerifyCode(req, res) {
  try {
    const { email, code, otpToken } = req.body || {};
    const result = await verifyCode(email, code, otpToken);
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth-trial] verifyCode", e);
    else logger.warn(`[auth-trial] verifyCode ${status}: ${e.message}`);
    return res.status(status).json({
      error: e.message || "Error al verificar",
      remainingAttempts: e.remainingAttempts,
    });
  }
}

async function postClaimTrial(req, res) {
  try {
    const user = getBearerUser(req);
    if (!user) {
      return res.status(401).json({ error: "Sesión requerida." });
    }
    const emailVerifiedToken = req.body?.emailVerifiedToken;
    if (!emailVerifiedToken) {
      return res.status(400).json({ error: "Falta el token de verificación de correo." });
    }
    const result = await claimVipTrial(user.id, user.email, emailVerifiedToken);
    return res.json({ ...result, trialDays: result.trialDays || VIP_TRIAL_DAYS });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth-trial] claimTrial", e);
    return res.status(status).json({ error: e.message || "Error al activar prueba VIP" });
  }
}

async function postPasswordForgot(req, res) {
  try {
    const email = req.body?.email;
    const redirectTo = req.body?.redirectTo;
    const result = await passwordReset.requestPasswordReset(email, redirectTo);
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth] passwordForgot", e);
    else logger.warn(`[auth] passwordForgot ${status}: ${e.message}`);
    return res.status(status).json({ ok: false, error: e.message || "Error al recuperar" });
  }
}

async function postPasswordVerifyCode(req, res) {
  try {
    const { email, code, otpToken } = req.body || {};
    const result = await passwordReset.verifyResetCode(email, code, otpToken);
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth] passwordVerify", e);
    return res.status(status).json({
      ok: false,
      error: e.message || "Error al verificar",
      remainingAttempts: e.remainingAttempts,
    });
  }
}

async function postPasswordConfirm(req, res) {
  try {
    const { email, password, resetGrant, recoveryToken } = req.body || {};
    const result = await passwordReset.confirmPasswordReset({
      email,
      password,
      resetGrant,
      recoveryToken,
    });
    return res.json(result);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth] passwordConfirm", e);
    return res.status(status).json({
      ok: false,
      error: e.message || "Error al actualizar contraseña",
      code: e.code,
    });
  }
}

/** POST /api/auth/google/token — canje code+PKCE → id_token (secret solo en servidor). */
async function postGoogleToken(req, res) {
  try {
    const { code, codeVerifier, redirectUri } = req.body || {};
    const result = await googleOauth.exchangeAuthorizationCode({
      code,
      codeVerifier,
      redirectUri,
    });
    return res.json({
      ok: true,
      id_token: result.idToken,
      expires_in: result.expiresIn,
    });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logger.error("[auth] googleToken", e);
    else logger.warn(`[auth] googleToken ${status}: ${e.code || e.message}`);
    return res.status(status).json({
      ok: false,
      error:
        e.message ||
        "No pudimos completar el acceso con Google. Intenta de nuevo.",
      code: e.code,
    });
  }
}

function getGoogleOauthStatus(_req, res) {
  return res.json({
    ok: true,
    configured: googleOauth.isGoogleOauthConfigured(),
  });
}

module.exports = {
  getEmailVerification,
  postSendCode,
  postVerifyCode,
  postClaimTrial,
  postPasswordForgot,
  postPasswordVerifyCode,
  postPasswordConfirm,
  postGoogleToken,
  getGoogleOauthStatus,
};
