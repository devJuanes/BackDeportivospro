const escalera = require("../services/escaleraService");

function handleError(res, error) {
  return res.status(error.status || 500).json({
    error: "EscaleraError",
    message: error.message || "Error interno",
  });
}

async function getActive(req, res) {
  try {
    const data = await escalera.getOverview(req.userId);
    return res.json(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function getHistory(req, res) {
  try {
    const limit = Number.parseInt(String(req.query.limit || "20"), 10);
    const sessions = await escalera.listHistory(req.userId, Number.isFinite(limit) ? limit : 20);
    return res.json({ sessions });
  } catch (e) {
    return handleError(res, e);
  }
}

async function openSession(req, res) {
  try {
    const session = await escalera.openSession({
      userId: req.userId,
      capitalInitial: req.body?.capital_initial,
      dailyTarget: req.body?.daily_target,
      multiplierMode: req.body?.multiplier_mode || "auto",
      notes: req.body?.notes || null,
    });
    return res.status(201).json({ session });
  } catch (e) {
    return handleError(res, e);
  }
}

async function closeSession(req, res) {
  try {
    const session = await escalera.closeSession({
      userId: req.userId,
      sessionId: req.params.sessionId,
      reason: req.body?.reason || "closed",
    });
    return res.json({ session });
  } catch (e) {
    return handleError(res, e);
  }
}

async function generateStep(req, res) {
  try {
    const data = await escalera.generateNext(req.userId, req.body?.session_id || null);
    return res.json(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function acceptStep(req, res) {
  try {
    const step = await escalera.acceptStep(
      req.userId,
      req.params.stepId,
      req.body?.stake_actual,
      req.body?.executed_odds
    );
    return res.json({ step });
  } catch (e) {
    return handleError(res, e);
  }
}

async function rejectStep(req, res) {
  try {
    const data = await escalera.rejectStep(req.userId, req.params.stepId);
    return res.json(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function resolveStep(req, res) {
  try {
    const data = await escalera.resolveStep(
      req.userId,
      req.params.stepId,
      String(req.body?.outcome || "").toLowerCase(),
      req.body?.executed_odds
    );
    return res.json(data);
  } catch (e) {
    return handleError(res, e);
  }
}

async function registerPush(req, res) {
  try {
    if (!req.body?.token) {
      return res.status(400).json({ error: "token requerido" });
    }
    const row = await escalera.registerPushToken(req.userId, req.body.token, req.body?.device_info || {});
    return res.status(201).json({ token: row });
  } catch (e) {
    return handleError(res, e);
  }
}

async function unregisterPush(req, res) {
  try {
    if (!req.body?.token) {
      return res.status(400).json({ error: "token requerido" });
    }
    const out = await escalera.unregisterPushToken(req.userId, req.body.token);
    return res.json(out);
  } catch (e) {
    return handleError(res, e);
  }
}

module.exports = {
  getActive,
  getHistory,
  openSession,
  closeSession,
  generateStep,
  acceptStep,
  rejectStep,
  resolveStep,
  registerPush,
  unregisterPush,
};
