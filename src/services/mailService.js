/**
 * Envío de correo transaccional (OTP verificación, etc.).
 * Requiere SMTP_* en .env del backend. Sin nodemailer instalado usa fetch a
 * un relay opcional, o falla con reason smtp_not_configured.
 */
const logger = require("../utils/logger");

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number.parseInt(process.env.SMTP_PORT || "465", 10),
    secure: process.env.SMTP_SECURE !== "false",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_APP_PASSWORD || process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
    fromName: process.env.SMTP_FROM_NAME || "MatuPicks",
  };
}

function isSmtpConfigured() {
  const c = getSmtpConfig();
  return Boolean(c.user && c.pass && c.from);
}

let transporterPromise = null;

async function getTransporter() {
  if (!isSmtpConfigured()) return null;
  if (transporterPromise) return transporterPromise;
  transporterPromise = (async () => {
    try {
      // eslint-disable-next-line import/no-extraneous-dependencies
      const nodemailer = require("nodemailer");
      const c = getSmtpConfig();
      return nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        auth: { user: c.user, pass: c.pass },
      });
    } catch (e) {
      logger.warn(`[mail] nodemailer no disponible: ${e.message}. Ejecuta: npm i nodemailer`);
      return null;
    }
  })();
  return transporterPromise;
}

/**
 * @returns {{ sent: boolean, reason?: string }}
 */
async function sendMail({ to, subject, text, html }) {
  const t = await getTransporter();
  const c = getSmtpConfig();
  if (!t) {
    logger.warn("[mail] SMTP no configurado (SMTP_USER / SMTP_PASS / SMTP_FROM)");
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    await t.sendMail({
      from: `${c.fromName} <${c.from}>`,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (e) {
    logger.error("[mail] sendMail", e);
    return { sent: false, reason: e.message || "smtp_error" };
  }
}

async function sendVerificationCodeEmail(email, code) {
  const subject = "Tu código MatuPicks";
  const text = `Tu código de verificación es: ${code}\n\nVálido por 10 minutos. Si no solicitaste esto, ignora este correo.\n\n— MatuPicks`;
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#0a0a0f;color:#fff;border-radius:16px;">
      <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;">MatuPicks</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;">Código de verificación</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#d1d5db;line-height:1.5;">
        Usa este código para confirmar tu correo y activar tu prueba VIP de 4 días.
      </p>
      <div style="letter-spacing:0.35em;font-size:28px;font-weight:800;text-align:center;padding:16px;background:#13131c;border-radius:12px;border:1px solid rgba(34,216,107,0.35);color:#22d86b;">
        ${code}
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#6b7280;">Válido 10 minutos. Si no pediste esto, ignora el mensaje.</p>
    </div>
  `;
  return sendMail({ to: email, subject, text, html });
}

/**
 * Correo de recuperación SuperWin: código OTP + enlace a la app.
 */
async function sendPasswordResetEmail(email, { code, resetUrl }) {
  const brand = process.env.SMTP_FROM_NAME || "SuperWin";
  const subject = `${brand}: recupera tu contraseña`;
  const text = [
    `Tu código para restablecer la contraseña es: ${code}`,
    "",
    `También puedes abrir: ${resetUrl}`,
    "",
    "Válido 10 minutos. Si no solicitaste esto, ignora el correo.",
    "",
    `— ${brand}`,
  ].join("\n");
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:0 auto;padding:24px;background:#f2f4f8;color:#151923;border-radius:16px;">
      <div style="background:#1b4dff;color:#fff;border-radius:12px;padding:18px 20px;margin-bottom:16px;">
        <p style="margin:0;font-size:13px;opacity:0.85;">${brand}</p>
        <h1 style="margin:6px 0 0;font-size:22px;font-weight:800;">Recuperar contraseña</h1>
      </div>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#374151;">
        Usa este código en la pantalla de recuperación:
      </p>
      <div style="letter-spacing:0.35em;font-size:28px;font-weight:800;text-align:center;padding:16px;background:#fff;border-radius:12px;border:1px solid #d5deef;color:#1b4dff;">
        ${code}
      </div>
      <p style="margin:18px 0 12px;font-size:14px;line-height:1.55;color:#374151;">
        O abre directamente:
      </p>
      <p style="text-align:center;margin:0 0 18px;">
        <a href="${resetUrl}" style="display:inline-block;background:#1b4dff;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:10px;">
          Restablecer contraseña
        </a>
      </p>
      <p style="margin:0;font-size:12px;color:#6b7280;">Válido 10 minutos. Si no pediste esto, ignora el mensaje.</p>
    </div>
  `;
  return sendMail({ to: email, subject, text, html });
}

module.exports = {
  isSmtpConfigured,
  sendMail,
  sendVerificationCodeEmail,
  sendPasswordResetEmail,
};
