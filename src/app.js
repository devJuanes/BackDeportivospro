const express = require("express");
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
const { getSupportedSports } = require("./services/sportsService");
const logger = require("./utils/logger");

const app = express();

/** Orígenes del front MatuPicks siempre permitidos (además de `CORS_ORIGIN` en .env). */
const DEFAULT_MATUPICKS_ORIGINS = [
  "https://matupicks.app",
  "https://www.matupicks.app",
  "http://localhost:5173",
  "http://localhost:5174",
];

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
    if (allowedOrigins.includes(normalized)) {
      return callback(null, true);
    }
    logger.warn(`[cors] Origen no permitido: ${normalized} (configura CORS_ORIGIN en el API si falta)`);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "x-blog-cron-secret"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "DeportivosPro backend",
    supportedSports: getSupportedSports(),
  });
});

app.use("/api/predictions", predictionRoutes);
app.use("/api/predictions", vipRoutes);
app.use("/api/predictions", liveRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/factory", factoryRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/blog", blogRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((error, req, res, next) => {
  // eslint-disable-line no-unused-vars
  res.status(500).json({
    error: "Error interno",
    message: error.message,
  });
});

module.exports = app;
