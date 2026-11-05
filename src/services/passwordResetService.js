/**
 * Recuperación de contraseña SuperWin:
 * 1) Envía código OTP por SMTP (correo brand).
 * 2) Dispara recover de MatuDB con redirectTo (enlace nativo).
 * 3) Al confirmar código + nueva clave, aplica reset en MatuDB con el token OTP
 *    firmado como bridge; si MatuDB exige su token de recover, el usuario puede
 *    pegar el token del enlace en el front.
 */
const crypto = require("crypto");
const {
  sendPasswordResetEmail,
  isSmtpConfigured,
} = require("./mailService");
const { db } = require("../config/database");
const logger = require("../utils/logger");

const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_SENDS_PER_HOUR = 6;
const MAX_ATTEMPTS = 5;
const sendBuckets = new Map();

function otpSecret() {
  return (
    process.env.OTP_HMAC_SECRET ||
    process.env.JWT_SECRET ||
    process.env.MATUDB_API_KEY ||
    "superwin-password-reset"
  );
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashCode(email, code, salt) {
  return crypto
    .createHmac("sha256", otpSecret())
    .update(`${email}:${code}:${salt}`)
    .digest("hex");
}

function signPayload(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", otpSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function unsignPayload(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", otpSecret()).update(payload).digest("base64url");
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function allowSend(email) {
  const now = Date.now();
  const bucket = sendBuckets.get(email) || [];
  const recent = bucket.filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    sendBuckets.set(email, recent);
    return false;
  }
  recent.push(now);
  sendBuckets.set(email, recent);
  return true;
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

function matuAuthBase() {
  const url = String(process.env.MATUDB_URL || process.env.VITE_MATUDB_URL || "").replace(
    /\/$/,
    "",
  );
  const projectId = String(
    process.env.MATUDB_PROJECT_ID || process.env.VITE_MATUDB_PROJECT_ID || "",
  ).trim();
  const apiKey = String(
    process.env.MATUDB_API_KEY || process.env.VITE_MATUDB_API_KEY || "",
  ).trim();
  if (!url || !projectId || !apiKey) return null;
  return {
    base: `${url}/api/projects/${projectId}/auth`,
    apiKey,
  };
}

async function triggerMatuRecover(email, redirectTo) {
  const cfg = matuAuthBase();
  if (!cfg) return { ok: false, reason: "matudb_not_configured" };
  try {
    const res = await fetch(`${cfg.base}/recover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.apiKey,
      },
      body: JSON.stringify({
        email,
        redirectTo,
        redirect_to: redirectTo,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        reason: json.message || `http_${res.status}`,
        notFound: /not found|no encontr/i.test(String(json.message || "")),
      };
    }
    return { ok: true, emailSent: Boolean(json?.data?.emailSent ?? true) };
  } catch (e) {
    logger.warn(`[password-reset] MatuDB recover: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

async function applyMatuPasswordReset(email, password, recoveryToken) {
  const cfg = matuAuthBase();
  if (!cfg) return { ok: false, reason: "matudb_not_configured" };

  const attempts = [];
  if (recoveryToken) {
    attempts.push({ password, token: recoveryToken });
    attempts.push({ new_password: password, token: recoveryToken });
    attempts.push({ password, recovery_token: recoveryToken });
  }
  attempts.push({ email, password });
  attempts.push({ email, new_password: password });
  attempts.push({ email, password, token: recoveryToken || undefined });

  let lastReason = "reset_failed";
  for (const body of attempts) {
    try {
      const res = await fetch(`${cfg.base}/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: cfg.apiKey,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, via: "matudb_reset" };
      lastReason = json.message || `http_${res.status}`;
    } catch (e) {
      lastReason = e.message;
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * Solicita recuperación: SMTP OTP + MatuDB recover.
 */
async function requestPasswordReset(rawEmail, redirectTo) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    const err = new Error("Correo no válido.");
    err.status = 400;
    throw err;
  }
  if (!isSmtpConfigured()) {
    const err = new Error(
      "El envío de correo no está configurado en el servidor (SMTP).",
    );
    err.status = 503;
    throw err;
  }
  if (!allowSend(email)) {
    const err = new Error("Demasiados intentos. Espera un momento e inténtalo de nuevo.");
    err.status = 429;
    throw err;
  }

  const safeRedirect =
    String(redirectTo || "").trim() ||
    `${process.env.APP_PUBLIC_URL || "http://localhost:5173"}/recuperar`;

  const matu = await triggerMatuRecover(email, safeRedirect);
  // Respuesta genérica si no existe (no filtrar cuentas).
  if (matu.notFound) {
    return {
      ok: true,
      sent: false,
      message:
        "Si el correo está registrado, recibirás instrucciones en unos minutos.",
    };
  }

  const code = generateCode();
  const salt = crypto.randomBytes(8).toString("hex");
  const codeHash = hashCode(email, code, salt);
  const otpToken = signPayload({
    email,
    codeHash,
    salt,
    attempts: 0,
    exp: Date.now() + OTP_TTL_MS,
    purpose: "password_reset_otp",
  });

  const resetUrl = `${safeRedirect.split("?")[0]}?email=${encodeURIComponent(email)}`;
  const mail = await sendPasswordResetEmail(email, { code, resetUrl });
  if (!mail.sent) {
    const err = new Error(
      "No pudimos enviar el correo. Revisa SMTP o inténtalo más tarde.",
    );
    err.status = 502;
    throw err;
  }

  logger.info(`[password-reset] OTP enviado a ${email.slice(0, 3)}***`);
  return {
    ok: true,
    sent: true,
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    otpToken,
    matuRecover: Boolean(matu.ok),
    message: "Te enviamos un código a tu correo.",
  };
}

/**
 * Verifica OTP → grant de corto plazo para fijar la nueva contraseña.
 */
async function verifyResetCode(rawEmail, rawCode, otpToken) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || "")
    .trim()
    .replace(/\s/g, "");
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    const err = new Error("Código o correo inválido.");
    err.status = 400;
    throw err;
  }

  const data = unsignPayload(otpToken);
  if (!data || data.purpose !== "password_reset_otp") {
    const err = new Error("Sesión inválida. Solicita un código nuevo.");
    err.status = 400;
    throw err;
  }
  if (normalizeEmail(data.email) !== email) {
    const err = new Error("El correo no coincide con el código solicitado.");
    err.status = 400;
    throw err;
  }
  if (typeof data.exp !== "number" || Date.now() > data.exp) {
    const err = new Error("El código expiró. Solicita uno nuevo.");
    err.status = 400;
    throw err;
  }
  const attempts = Number(data.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) {
    const err = new Error("Demasiados intentos. Solicita un código nuevo.");
    err.status = 429;
    throw err;
  }

  const expected = hashCode(email, code, data.salt);
  if (expected !== data.codeHash) {
    const err = new Error("Código incorrecto.");
    err.status = 400;
    err.remainingAttempts = MAX_ATTEMPTS - attempts - 1;
    throw err;
  }

  const resetGrant = signPayload({
    email,
    exp: Date.now() + RESET_GRANT_TTL_MS,
    purpose: "password_reset_grant",
  });
  return { ok: true, resetGrant };
}

/**
 * Aplica nueva contraseña con grant OTP y/o token MatuDB.
 */
async function confirmPasswordReset({
  email: rawEmail,
  password,
  resetGrant,
  recoveryToken,
}) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    const err = new Error("Correo no válido.");
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error("La contraseña debe tener al menos 6 caracteres.");
    err.status = 400;
    throw err;
  }

  let grantOk = false;
  if (resetGrant) {
    const data = unsignPayload(resetGrant);
    grantOk =
      Boolean(data) &&
      data.purpose === "password_reset_grant" &&
      normalizeEmail(data.email) === email &&
      typeof data.exp === "number" &&
      Date.now() <= data.exp;
  }

  if (!grantOk && !recoveryToken) {
    const err = new Error(
      "Verifica el código del correo o usa el enlace de recuperación.",
    );
    err.status = 401;
    throw err;
  }

  const applied = await applyMatuPasswordReset(
    email,
    String(password),
    recoveryToken || undefined,
  );

  if (!applied.ok) {
    // Si solo tenemos grant OTP y MatuDB no aceptó reset sin su token,
    // re-disparamos recover y pedimos usar el enlace del segundo correo / token URL.
    if (grantOk && !recoveryToken) {
      const redirectTo =
        `${process.env.APP_PUBLIC_URL || "http://localhost:5173"}/recuperar`;
      await triggerMatuRecover(email, redirectTo);
      const err = new Error(
        "Código verificado. Abre el enlace del correo de recuperación para confirmar la nueva contraseña, o pega el token del enlace aquí.",
      );
      err.status = 409;
      err.code = "NEED_MATU_TOKEN";
      throw err;
    }
    const err = new Error(
      applied.reason || "No se pudo actualizar la contraseña.",
    );
    err.status = 502;
    throw err;
  }

  try {
    await db
      .from("pf_users")
      .update({ updated_at: new Date().toISOString() })
      .eq("email", email);
  } catch {
    /* ignore */
  }

  return { ok: true, message: "Contraseña actualizada. Ya puedes iniciar sesión." };
}

module.exports = {
  requestPasswordReset,
  verifyResetCode,
  confirmPasswordReset,
};
