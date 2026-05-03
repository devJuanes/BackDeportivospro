const { db } = require("../config/database");
const logger = require("./logger");
const { isAdminBearer, getUserIdFromBearer, getEmailFromBearer } = require("./jwtAdmin");

function rowIsAdmin(row) {
  if (!row || typeof row !== "object") return false;
  const v = row.is_admin;
  if (v === true || v === 1) return true;
  if (typeof v === "string") return ["true", "t", "1", "yes"].includes(v.trim().toLowerCase());
  return false;
}

/**
 * Admin para acciones HTTP: JWT con claim de admin **o** `pf_users.is_admin`.
 * El panel puede marcar staff en BD sin que el JWT traiga `role: admin`.
 * Si `sub` del JWT no coincide con `pf_users.id`, se intenta por `email` del token.
 */
async function isAdminHttpRequest(req) {
  const auth = req.get("authorization");
  if (isAdminBearer(auth)) return true;
  const userId = getUserIdFromBearer(auth);
  if (userId) {
    const { data, error } = await db
      .from("pf_users")
      .select("is_admin")
      .eq("id", userId)
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.warn(`adminHttpAuth pf_users by id: ${error.message || String(error)}`);
    } else if (rowIsAdmin(data)) {
      return true;
    }
  }
  const email = getEmailFromBearer(auth);
  if (email) {
    const { data, error } = await db
      .from("pf_users")
      .select("is_admin")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.warn(`adminHttpAuth pf_users by email: ${error.message || String(error)}`);
    } else if (rowIsAdmin(data)) {
      return true;
    }
  }
  return false;
}

module.exports = { isAdminHttpRequest };
