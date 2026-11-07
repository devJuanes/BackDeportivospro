const express = require("express");
const path = require("node:path");
const cors = require("cors");
const morgan = require("morgan");
const predictionRoutes = require("./routes/predictionRoutes");
const vipRoutes = require("./routes/vipRoutes");
const liveRoutes = require("./routes/liveRoutes");
const newsRoutes = require("./routes/newsRoutes");
const factoryRoutes = require("./routes/factoryRoutes");
const whatsappRoutes = require("./routes/whatsappRoutes");
const paymentsRoutes = require("./routes/paymentsRoutes");
const blogRoutes = require("./routes/blogRoutes");
const escaleraRoutes = require("./routes/escaleraRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const authTrialRoutes = require("./routes/authTrialRoutes");
const vipRequestRoutes = require("./routes/vipRequestRoutes");
const apiV1Routes = require("./routes/apiV1Routes");
const communityRoutes = require("./routes/communityRoutes");
const { getSupportedSports } = require("./services/sportsService");
const { getStats: getTeamsStats } = require("./services/teamsService");
const logger = require("./utils/logger");

const app = express();

/** Orígenes del front siempre permitidos (además de `CORS_ORIGIN` en .env). */
const DEFAULT_MATUPICKS_ORIGINS = [
  "https://winquina.com",
  "https://www.winquina.com",
  "https://towin-fe4cc.web.app",
  "https://matupicks.app",
  "https://www.matupicks.app",
  "https://picks.logsfm.com",
  "http://picks.logsfm.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
];

/** Admin/Fábrica desde Vite en tu máquina contra API en producción (evita depender solo del .env del servidor). */
function isLocalDevHttpOrigin(origin) {
  try {
    const u = new URL(String(origin).trim());
    if (u.protocol !== "http:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function buildCorsOrigins() {
  const raw = (process.env.CORS_ORIGIN || "").trim();
  const fromEnv = raw
    ? raw
        .split(",")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean)
    : [];
  return [...new Set([...fromEnv, ...DEFAULT_MATUPICKS_ORIGINS])];
}

const allowedOrigins = buildCorsOrigins();

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = String(origin).trim().replace(/\/+$/, "");
    if (allowedOrigins.includes(normalized) || isLocalDevHttpOrigin(normalized)) {
      return callback(null, true);
    }
    logger.warn(`[cors] Origen no permitido: ${normalized} (configura CORS_ORIGIN en el API si falta)`);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-blog-cron-secret",
    "X-Demo-Key",
    "x-demo-key",
    "apikey",
    "ApiKey",
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

/** Webhook Landa Pay: body crudo antes de express.json (firma Landa-Signature). */
const { landapayWebhook } = require("./controllers/landapayPaymentsController");
app.post(
  "/api/payments/landapay/webhook",
  express.raw({ type: "application/json" }),
  landapayWebhook,
);

app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "DeportivosPro API",
    version: "v1",
    supportedSports: getSupportedSports(),
  });
});

app.use("/api/v1", apiV1Routes);

/**
 * Precalienta el indice de equipos/ligas (data/futbool) para que el primer
 * request a /api/v1/teams|leagues no pague el build (~100 ms).
 */
setImmediate(() => {
  try {
    const stats = getTeamsStats();
    logger.info(
      `[teams] indice listo: ${stats.leagues} ligas, ${stats.teams} equipos, ${stats.logos} logos (${stats.buildMs}ms)`,
    );
  } catch (error) {
    logger.warn(`[teams] no se pudo precalentar el indice: ${error.message}`);
  }
});
/** Team/league logos copied from futbool → `data/futbool/logos/<league>/<team>.png` */
app.use(
  "/assets/leagues",
  express.static(path.join(__dirname, "..", "data", "futbool", "logos"), {
    maxAge: "7d",
    fallthrough: true,
  })
);
app.use(
  "/assets/news",
  express.static(path.join(__dirname, "..", "data", "news", "images"), {
    maxAge: "1d",
    fallthrough: true,
  })
);
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/predictions", predictionRoutes);
app.use("/api/predictions", vipRoutes);
app.use("/api/predictions", liveRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/factory", factoryRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/blog", blogRoutes);
app.use("/api/escalera", escaleraRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/auth", authTrialRoutes);
app.use("/api/vip", vipRequestRoutes);
app.use("/api/community", communityRoutes);
// Compatibilidad con clientes que usan prefijo por proyecto (MatuHttpClient Android).
app.use("/api/projects/:projectId/escalera", escaleraRoutes);
app.use("/api/projects/:projectId/notifications", notificationsRoutes);
app.use("/api/projects/:projectId/vip", vipRequestRoutes);

const adminRoutes = require("./routes/adminRoutes");
app.use("/api/admin", adminRoutes);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Ruta no encontrada" });
});

app.use((error, req, res, next) => {
  // eslint-disable-line no-unused-vars
  logger.error(`[api] ${error.message}`);
  res.status(500).json({
    ok: false,
    error: "Error interno",
    message: error.message,
  });
});

module.exports = app;
