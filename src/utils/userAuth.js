const { getUserIdFromBearer } = require("./jwtAdmin");

function resolveUserId(req) {
  const byHeader = String(req.get("x-user-id") || "").trim();
  if (byHeader) return byHeader;
  return getUserIdFromBearer(req.get("authorization")) || null;
}

function requireUser(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) {
    return res.status(401).json({
      error: "No autenticado",
      message: "Envía Authorization Bearer o x-user-id",
    });
  }
  req.userId = userId;
  return next();
}

module.exports = { resolveUserId, requireUser };
