const { runFactoryCycleNow, getFactoryStatus } = require("../services/factoryService");
const { listSources, syncDefaultSources } = require("../services/sourceService");
const { isWhatsAppReady } = require("../config/whatsapp");

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
    const result = await runFactoryCycleNow({ includeNews: true });
    res.json(result);
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
  getSources,
  syncSources,
};
