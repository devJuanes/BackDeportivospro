const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const logger = require("../utils/logger");
const { getFreePredictions } = require("../models/predictionModel");
const { getVipPredictions } = require("../models/vipModel");
const { runFactoryCycleNow, getFactoryStatus } = require("../services/factoryService");
const { getCurrentLiveSignals } = require("../services/liveSignalService");

let client = null;
let ready = false;
const processedMessageIds = new Set();

function normalizeChatId(value = "") {
  const raw = String(value).trim();
  if (raw.endsWith("@c.us") || raw.endsWith("@g.us")) {
    return raw;
  }
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : raw;
}

function menuText() {
  return `🤖 DEPORTIVOSPRO BOT

Responde con una opción:
1) Ver pronósticos GRATIS del día
2) Ver pronósticos VIP del día
3) Ver alertas EN VIVO
4) Generar lote del día ahora
5) Estado de fábrica

Comandos rápidos:
- menu
- free
- vip
- live
- generar`;
}

function formatPickRow(row) {
  return `• ${row.home_team_name} vs ${row.away_team_name}
  Pick: ${row.prediction}
  Conf: ${row.confidence}% | Cuota: ${row.odds}
  Hora: ${row.match_hour || "-"} | Estado: ${row.state || "pendiente"}`;
}

async function buildFactoryStatus() {
  const status = await getFactoryStatus();
  return `🏭 Estado de fábrica
- WhatsApp: ${ready ? "READY" : "NO READY"}
- Free hoy: ${status.free_today.total}
- VIP hoy: ${status.vip_today.total}
- Live recientes: ${status.live_recent_count}
- Fuentes activas (football): ${status.sources.total_active_sources}
- Último ciclo: ${status.last_run_finished_at || "sin ejecutar"}`;
}

async function processBotCommand(message) {
  const text = String(message.body || "").trim().toLowerCase();
  if (!text) {
    return;
  }

  if (["hola", "menu", "menú", "ayuda", "help", "start"].includes(text)) {
    await message.reply(menuText());
    return;
  }

  if (["1", "free", "gratis"].includes(text)) {
    const rows = await getFreePredictions(5, { todayOnly: true });
    if (rows.length === 0) {
      await message.reply("No hay pronósticos FREE para hoy. Escribe 4 para generar lote.");
      return;
    }
    await message.reply(`⚽ FREE HOY\n\n${rows.map(formatPickRow).join("\n\n")}`);
    return;
  }

  if (["2", "vip"].includes(text)) {
    const rows = await getVipPredictions(5, { todayOnly: true });
    if (rows.length === 0) {
      await message.reply("No hay pronósticos VIP para hoy. Escribe 4 para generar lote.");
      return;
    }
    await message.reply(`🔥 VIP HOY\n\n${rows.map(formatPickRow).join("\n\n")}`);
    return;
  }

  if (["3", "live", "vivo", "en vivo"].includes(text)) {
    const rows = await getCurrentLiveSignals({});
    const topRows = rows.slice(0, 5);
    if (topRows.length === 0) {
      await message.reply("No hay alertas live en este momento.");
      return;
    }
    const formatted = topRows.map((row) => {
      return `• ${row.home_team_name} vs ${row.away_team_name}
  Min: ${row.minute}
  Señal: ${row.prediction}
  Conf: ${row.confidence}%`;
    });
    await message.reply(`📡 ALERTAS LIVE (tiempo real)\n\n${formatted.join("\n\n")}`);
    return;
  }

  if (["4", "generar", "generar hoy", "lote"].includes(text)) {
    await message.reply("Generando lote del día... ⏳");
    const result = await runFactoryCycleNow({ includeNews: true });
    const pipeline = result.last_run_result?.pipeline || { free: 0, vip: 0 };
    await message.reply(
      `✅ Lote generado\n- Free: ${pipeline.free}\n- VIP: ${pipeline.vip}\nEscribe "free" o "vip" para ver picks de hoy.`
    );
    return;
  }

  if (["5", "estado", "status"].includes(text)) {
    const status = await buildFactoryStatus();
    await message.reply(status);
    return;
  }

  await message.reply(`No entendí ese comando.\n\n${menuText()}`);
}

async function handleIncomingMessage(message) {
  const messageId = message?.id?._serialized || `${message.from}-${message.timestamp}`;
  if (processedMessageIds.has(messageId)) {
    return;
  }
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    processedMessageIds.clear();
  }

  logger.info(`WhatsApp mensaje recibido de ${message.from}: ${message.body || ""}`);
  await processBotCommand(message);
}

function initWhatsApp() {
  if (process.env.WHATSAPP_ENABLED !== "true") {
    logger.info("WhatsApp deshabilitado por configuración.");
    return null;
  }

  if (client) {
    return client;
  }

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "deportivospro-bot" }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", (qr) => {
    ready = false;
    logger.info("Escanea el QR de WhatsApp (aparece abajo en consola).");
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    logger.info("WhatsApp autenticado. Esperando estado READY...");
  });

  client.on("ready", () => {
    ready = true;
    logger.info("WhatsApp bot conectado.");
  });

  client.on("auth_failure", (message) => {
    logger.error(`Error autenticando WhatsApp: ${message}`);
  });

  client.on("disconnected", (reason) => {
    ready = false;
    logger.warn(`WhatsApp desconectado: ${reason}`);
  });

  client.on("message", async (message) => {
    try {
      await handleIncomingMessage(message);
    } catch (error) {
      logger.warn(`Error procesando comando WhatsApp: ${error.message}`);
      await message.reply("Ocurrió un error procesando tu solicitud.");
    }
  });

  // Fallback para versiones/clientes donde 'message' no dispara de forma consistente.
  client.on("message_create", async (message) => {
    if (message.fromMe) {
      return;
    }
    try {
      await handleIncomingMessage(message);
    } catch (error) {
      logger.warn(`Error procesando message_create: ${error.message}`);
      await message.reply("Ocurrió un error procesando tu solicitud.");
    }
  });

  client.initialize().catch((error) => {
    logger.error(`No se pudo iniciar WhatsApp: ${error.message}`);
    logger.error(
      "Si estás en VPS Linux, instala librerías de Chromium y opcionalmente define CHROME_EXECUTABLE_PATH=/usr/bin/chromium-browser."
    );
  });

  return client;
}

async function sendMessage(to, message) {
  if (!client || !ready) {
    logger.warn("WhatsApp no está listo. Mensaje no enviado.");
    return false;
  }
  await client.sendMessage(normalizeChatId(to), message);
  return true;
}

function isWhatsAppReady() {
  return ready;
}

module.exports = {
  initWhatsApp,
  sendMessage,
  isWhatsAppReady,
};
