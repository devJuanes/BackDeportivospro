const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const predictionRoutes = require("./routes/predictionRoutes");
const vipRoutes = require("./routes/vipRoutes");
const liveRoutes = require("./routes/liveRoutes");
const newsRoutes = require("./routes/newsRoutes");
const factoryRoutes = require("./routes/factoryRoutes");
const whatsappRoutes = require("./routes/whatsappRoutes");
const { getSupportedSports } = require("./services/sportsService");

const app = express();

app.use(cors());
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
