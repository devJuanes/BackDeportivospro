/**
 * Verificación de correo por OTP — sin MatuDB.
 * El backend solo genera/envía el código y firma tokens.
 * Auth + pf_users los maneja el front contra MatuDB.
 */
const crypto = require("crypto");
const { sendVerificationCodeEmail, isSmtpConfigured } = require("./mailService");
const logger = require("../utils/logger");

const OTP_TTL_MS = 10 * 60 * 1000;
const VERIFY_TOKEN_TTL_MS = 30 * 60 * 1000;
const VIP_TRIAL_DAYS = 4;
const MAX_SENDS_PER_HOUR = 6;
const MAX_ATTEMPTS = 5;

/** Rate-limit en memoria (por proceso). Suficiente en local / un solo nodo. */
const sendBuckets = new Map();

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.org",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "sharklasers.com",
  "throwaway.email",
  "trashmail.com",
  "discard.email",
  "getnada.com",
  "moakt.com",
]);

function otpSecret() {
  return (
    process.env.OTP_HMAC_SECRET ||
    process.env.JWT_SECRET ||
    process.env.MATUDB_API_KEY ||
    process.env.VITE_MATUDB_API_KEY ||
    "matupicks-otp-dev-secret"
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

function isDisposableEmail(email) {
  const domain = email.split("@")[1] || "";
  return DISPOSABLE_DOMAINS.has(domain);
}

function hashCode(email, code, salt) {
  return crypto
    .createHmac("sha256", otpSecret())
    .update(`${email}:${code}:${salt}`)
    .digest("hex");
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
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
  const hourAgo = now - 60 * 60 * 1000;
  let times = sendBuckets.get(email) || [];
  times = times.filter((t) => t > hourAgo);
  if (times.length >= MAX_SENDS_PER_HOUR) return false;
  times.push(now);
  sendBuckets.set(email, times);
  return true;
}

function signEmailVerifiedToken(email) {
  return signPayload({
    email,
    exp: Date.now() + VERIFY_TOKEN_TTL_MS,
    purpose: "email_verified",
  });
}

function verifyEmailVerifiedToken(token) {
  const data = unsignPayload(token);
  if (!data || data.purpose !== "email_verified") return null;
  if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
  const email = normalizeEmail(data.email);
  if (!isValidEmail(email)) return null;
  return email;
}

/**
 * Envía código de 6 dígitos. Devuelve `otpToken` opaco (hash del código, sin BD).
 */
async function sendVerificationCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    const err = new Error("Correo no válido.");
    err.status = 400;
    throw err;
  }
  if (isDisposableEmail(email)) {
    const err = new Error("Usa un correo personal o de trabajo permanente.");
    err.status = 400;
    throw err;
  }
  if (!isSmtpConfigured()) {
    const err = new Error(
      "El envío de correo no está configurado en el servidor (SMTP). Contacta soporte.",
    );
    err.status = 503;
    throw err;
  }
  if (!allowSend(email)) {
    const err = new Error("Demasiados intentos. Espera un momento e inténtalo de nuevo.");
    err.status = 429;
    throw err;
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
    purpose: "email_otp",
  });

  const mail = await sendVerificationCodeEmail(email, code);
  if (!mail.sent) {
    const err = new Error("No pudimos enviar el correo. Revisa SMTP o inténtalo más tarde.");
    err.status = 502;
    throw err;
  }

  logger.info(`[otp] Código enviado a ${email.slice(0, 3)}*** (sin MatuDB)`);
  return {
    ok: true,
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    otpToken,
  };
}

/**
 * Verifica código + otpToken → emailVerifiedToken para crear la cuenta en el front.
 */
async function verifyCode(rawEmail, rawCode, otpToken) {
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
  if (!data || data.purpose !== "email_otp") {
    const err = new Error("Sesión de verificación inválida. Solicita un código nuevo.");
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
    const err = new Error("Demasiados intentos fallidos. Solicita un código nuevo.");
    err.status = 429;
    throw err;
  }

  const expected = hashCode(email, code, data.salt);
  if (expected !== data.codeHash) {
    const err = new Error("Código incorrecto.");
    err.status = 400;
    // Cliente debe reutilizar otpToken; no incrementamos en servidor sin estado.
    // Intentos quedan en el token solo si re-firmamos — devolvemos hint.
    err.remainingAttempts = MAX_ATTEMPTS - attempts - 1;
    throw err;
  }

  const emailVerifiedToken = signEmailVerifiedToken(email);
  return { ok: true, emailVerifiedToken };
}

/**
 * Grant VIP trial ya NO usa MatuDB aquí (lo hace el front).
 * Se mantiene por compatibilidad: valida el token y responde trialDays.
 */
async function claimVipTrial(_userId, userEmail, emailVerifiedToken) {
  const verifiedEmail = verifyEmailVerifiedToken(emailVerifiedToken);
  if (!verifiedEmail) {
    const err = new Error("Verificación de correo inválida o expirada.");
    err.status = 401;
    throw err;
  }
  const email = normalizeEmail(userEmail);
  if (verifiedEmail !== email) {
    const err = new Error("El correo verificado no coincide con tu cuenta.");
    err.status = 403;
    throw err;
  }
  return {
    ok: true,
    granted: false,
    alreadyClaimed: false,
    grantOnClient: true,
    trialDays: VIP_TRIAL_DAYS,
    message: "Aplica el trial en el cliente contra MatuDB (pf_users).",
  };
}

module.exports = {
  sendVerificationCode,
  verifyCode,
  claimVipTrial,
  verifyEmailVerifiedToken,
  VIP_TRIAL_DAYS,
};
