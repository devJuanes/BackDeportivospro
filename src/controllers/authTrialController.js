const {
  sendVerificationCode,
  verifyCode,
  claimVipTrial,
  VIP_TRIAL_DAYS,
} = require("../services/emailOtpService");
const { getUserIdFromBearer, getEmailFromBearer } = require("../utils/jwtAdmin");
const logger = require("../utils/logger");

function getBearerUser(req) {
  const auth = req.headers.authorization || "";
  const id = getUserIdFromBearer(auth);
  const email = getEmailFromBearer(auth);
  if (!id || !email) return null;
  return { id, email };
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
    return res.status(status).json({ error: e.message || "Error al enviar código" });
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

module.exports = {
  postSendCode,
  postVerifyCode,
  postClaimTrial,
};
