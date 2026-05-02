const { db } = require("../config/database");

const TABLE = "wompi_vip_redemptions";

/**
 * @param {string} userId
 * @param {number} limit
 * @returns {Promise<Array<{ reference: string, wompi_transaction_id: string | null, created_at: string }>>}
 */
async function listWompiRedemptionsByUserId(userId, limit = 30) {
  const { data, error } = await db
    .from(TABLE)
    .select("reference, wompi_transaction_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 30, 1), 50));

  if (error) {
    throw new Error(error.message || "Error listando pagos VIP");
  }
  return data || [];
}

module.exports = {
  listWompiRedemptionsByUserId,
};
