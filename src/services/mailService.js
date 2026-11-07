/**
 * Correo transaccional Winquina (OTP, recuperación).
 * Entrega: multipart text+html, logo CID inline, headers de prioridad,
 * Message-ID estable, List-Unsubscribe, sin URLs acortadas ni spam bait.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");

const BANNER_CANDIDATES = [
  path.join(__dirname, "../../assets/email/winquina-banner.png"),
  path.join(__dirname, "../../assets/email/winquina-banner.jpg"),
];

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number.parseInt(process.env.SMTP_PORT || "465", 10),
    secure: process.env.SMTP_SECURE !== "false",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_APP_PASSWORD || process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
    fromName: process.env.SMTP_FROM_NAME || "Winquina",
    replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER || "",
    supportEmail:
      process.env.SMTP_SUPPORT_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "deportivospro@gmail.com",
    appUrl: String(process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || "https://winquina.com").replace(
      /\/$/,
      "",
    ),
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
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
        // Gmail: identidad alineada con la cuenta autenticada
        name: undefined,
      });
    } catch (e) {
      logger.warn(`[mail] nodemailer no disponible: ${e.message}. Ejecuta: npm i nodemailer`);
      return null;
    }
  })();
  return transporterPromise;
}

function resolveBanner() {
  for (const file of BANNER_CANDIDATES) {
    if (fs.existsSync(file)) {
      return {
        filename: path.basename(file),
        path: file,
        cid: "winquina-logo@winquina",
        contentType: file.endsWith(".png") ? "image/png" : "image/jpeg",
      };
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMessageId(to) {
  const domain = String(getSmtpConfig().from).split("@")[1] || "winquina.com";
  const id = crypto.randomBytes(12).toString("hex");
  return `<${id}.${Date.now()}@${domain}>`;
}

/**
 * Plantilla estilo corporativo limpio (centrada, tipografía clara, filas clave/valor).
 */
function buildTransactionalHtml({
  brand,
  title,
  introHtml,
  rows,
  note,
  logoCid,
  supportEmail,
}) {
  const rowsHtml = (rows || [])
    .map(
      (row) => `
      <tr>
        <td style="padding:14px 0;border-top:1px solid #e8ebf0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b7280;width:38%;vertical-align:top;">
          ${escapeHtml(row.label)}
        </td>
        <td style="padding:14px 0;border-top:1px solid #e8ebf0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111827;font-weight:700;text-align:right;vertical-align:top;letter-spacing:${
          row.mono ? "0.12em" : "normal"
        };">
          ${escapeHtml(row.value)}
        </td>
      </tr>`,
    )
    .join("");

  const logoBlock = logoCid
    ? `<img src="cid:${logoCid}" width="220" alt="${escapeHtml(brand)}" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;max-width:220px;height:auto;" />`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:800;color:#1b4dff;letter-spacing:-0.02em;">${escapeHtml(
        brand,
      )}</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#111827;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">
    ${escapeHtml(title)} — código de verificación Winquina. No reenvíes este correo.
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:36px 20px 48px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;">
          <tr>
            <td align="center" style="padding:0 0 28px;">
              ${logoBlock}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 8px 12px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.25;font-weight:800;color:#111827;">
              ${escapeHtml(title)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#4b5563;">
              ${introHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:0 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                ${rowsHtml}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#9ca3af;">
              ${escapeHtml(note)}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#9ca3af;">
              ¿Necesitas ayuda? Escríbenos a
              <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1b4dff;text-decoration:none;font-weight:700;">${escapeHtml(
                supportEmail,
              )}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * @returns {{ sent: boolean, reason?: string, messageId?: string }}
 */
async function sendMail({
  to,
  subject,
  text,
  html,
  headers = {},
  attachments = [],
  category = "transactional",
}) {
  const t = await getTransporter();
  const c = getSmtpConfig();
  if (!t) {
    logger.warn("[mail] SMTP no configurado (SMTP_USER / SMTP_PASS / SMTP_FROM)");
    return { sent: false, reason: "smtp_not_configured" };
  }

  const messageId = buildMessageId(to);
  const unsubscribeMailto = `mailto:${c.supportEmail}?subject=${encodeURIComponent(
    "Unsubscribe Winquina",
  )}`;

  try {
    const info = await t.sendMail({
      from: `"${c.fromName}" <${c.from}>`,
      to,
      replyTo: c.replyTo || c.from,
      subject,
      text,
      html,
      attachments,
      messageId,
      // Prioridad alta en clientes que respetan estos headers (Outlook/Apple).
      // Gmail "Importante" se basa en reputación + engagement; esto refuerza la señal.
      priority: "high",
      headers: {
        "X-Priority": "1",
        Priority: "urgent",
        Importance: "high",
        "X-MSMail-Priority": "High",
        "X-Mailer": "Winquina Mailer 1.0",
        "X-Auto-Response-Suppress": "OOF, AutoReply",
        "Auto-Submitted": "auto-generated",
        "X-Entity-Ref-ID": crypto.randomBytes(8).toString("hex"),
        "X-Winquina-Category": category,
        "List-Unsubscribe": `<${unsubscribeMailto}>, <${c.appUrl}/cuenta>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "Feedback-ID": `winquina:${category}:otp`,
        ...headers,
      },
      // Evita que algunos filtros marquen el mensaje como bulk marketing
      envelope: {
        from: c.from,
        to,
      },
    });
    logger.info(`[mail] enviado a ${String(to).slice(0, 3)}*** id=${info.messageId || messageId}`);
    return { sent: true, messageId: info.messageId || messageId };
  } catch (e) {
    logger.error("[mail] sendMail", e);
    return { sent: false, reason: e.message || "smtp_error" };
  }
}

async function sendVerificationCodeEmail(email, code) {
  const c = getSmtpConfig();
  const brand = c.fromName;
  const safeCode = String(code || "").trim().toUpperCase();
  const banner = resolveBanner();

  const subject = `Tu código de verificación Winquina: ${safeCode}`;
  const text = [
    "Winquina",
    "",
    "Verifica tu correo",
    "",
    `Hola, confirma tu correo en Winquina para completar el registro.`,
    "",
    `Código: ${safeCode}`,
    "Estado: Pendiente de verificación",
    "Válido: 10 minutos",
    "",
    "Si no solicitaste crear una cuenta, ignora este mensaje.",
    "",
    `Ayuda: ${c.supportEmail}`,
    `— ${brand}`,
  ].join("\n");

  const html = buildTransactionalHtml({
    brand,
    title: "Verifica tu correo",
    introHtml: `Para completar tu registro en <strong style="color:#111827;">Winquina</strong>, introduce este código en la pantalla de creación de cuenta.`,
    rows: [
      { label: "Código", value: safeCode, mono: true },
      { label: "Estado", value: "Pendiente de verificación" },
      { label: "Válido por", value: "10 minutos" },
    ],
    note: "Si no solicitaste crear una cuenta en Winquina, puedes ignorar este correo con seguridad.",
    logoCid: banner ? banner.cid : null,
    supportEmail: c.supportEmail,
  });

  const attachments = banner
    ? [
        {
          filename: banner.filename,
          path: banner.path,
          cid: banner.cid,
          contentType: banner.contentType,
          contentDisposition: "inline",
        },
      ]
    : [];

  return sendMail({
    to: email,
    subject,
    text,
    html,
    attachments,
    category: "email-verification",
    headers: {
      "X-Winquina-Purpose": "email-verification",
    },
  });
}

async function sendPasswordResetEmail(email, { code, resetUrl }) {
  const c = getSmtpConfig();
  const brand = c.fromName;
  const safeCode = String(code || "").trim();
  const safeUrl = String(resetUrl || c.appUrl).trim();
  const banner = resolveBanner();

  const subject = `Restablece tu contraseña Winquina`;
  const text = [
    "Winquina",
    "",
    "Restablecer contraseña",
    "",
    "Recibimos una solicitud para cambiar la contraseña de tu cuenta Winquina.",
    "",
    `Código: ${safeCode}`,
    `Enlace: ${safeUrl}`,
    "Válido: 10 minutos",
    "",
    "Si no solicitaste este cambio, ignora el mensaje.",
    "",
    `Ayuda: ${c.supportEmail}`,
    `— ${brand}`,
  ].join("\n");

  const html = buildTransactionalHtml({
    brand,
    title: "Restablecer contraseña",
    introHtml: `Recibimos una solicitud para cambiar la contraseña de tu cuenta en <strong style="color:#111827;">Winquina</strong>. Usa el código o abre el enlace seguro.`,
    rows: [
      { label: "Código", value: safeCode, mono: true },
      { label: "Estado", value: "Solicitud de recuperación" },
      { label: "Válido por", value: "10 minutos" },
      { label: "Enlace", value: safeUrl },
    ],
    note: "Si no pediste recuperar tu contraseña, ignora este correo. Tu cuenta sigue segura.",
    logoCid: banner ? banner.cid : null,
    supportEmail: c.supportEmail,
  });

  const attachments = banner
    ? [
        {
          filename: banner.filename,
          path: banner.path,
          cid: banner.cid,
          contentType: banner.contentType,
          contentDisposition: "inline",
        },
      ]
    : [];

  return sendMail({
    to: email,
    subject,
    text,
    html,
    attachments,
    category: "password-reset",
    headers: {
      "X-Winquina-Purpose": "password-reset",
    },
  });
}

module.exports = {
  isSmtpConfigured,
  sendMail,
  sendVerificationCodeEmail,
  sendPasswordResetEmail,
};
