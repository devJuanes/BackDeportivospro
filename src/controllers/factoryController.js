const {
  runFactoryCycleNow,
  getFactoryStatus,
  setFactoryEnabled,
} = require("../services/factoryService");
const { listSources, syncDefaultSources } = require("../services/sourceService");
const { isWhatsAppReady } = require("../config/whatsapp");
const { isAdminHttpRequest } = require("../utils/adminHttpAuth");

async function getStatus(req, res, next) {
  try {
    const status = await getFactoryStatus();
    res.json({
      ...status,
      whatsapp_ready: isWhatsAppReady(),
    });
  } catch (error) {
    next(error);
  }
}

async function runNow(req, res, next) {
  try {
    if (!(await isAdminHttpRequest(req))) {
      return res.status(403).json({
        error: "forbidden",
        message:
          "Se requiere sesión de administrador (JWT con role admin o usuario con pf_users.is_admin).",
      });
    }
    const raw =
      (req.body && req.body.match_date) ||
      (typeof req.query?.match_date === "string" && req.query.match_date) ||
      "";
    const matchDate = String(raw).trim();
    if (matchDate && !/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) {
      return res.status(400).json({ error: "bad_request", message: "match_date debe ser YYYY-MM-DD" });
    }
    const result = await runFactoryCycleNow({
      includeNews: true,
      matchDate: matchDate || null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

async function setPower(req, res, next) {
  try {
    const enabled = req.body?.enabled === true;
    const state = setFactoryEnabled(enabled);
    res.json({
      ok: true,
      ...state,
    });
  } catch (error) {
    next(error);
  }
}

async function getSources(req, res, next) {
  try {
    const rows = await listSources(300);
    res.json(rows);
  } catch (error) {
    next(error);
  }
}

async function syncSources(req, res, next) {
  try {
    const rows = await syncDefaultSources();
    res.json({
      synced: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getStatus,
  runNow,
  setPower,
  getSources,
  syncSources,
};
