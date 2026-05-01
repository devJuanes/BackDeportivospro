const axios = require("axios");
const logger = require("../utils/logger");

function wompiApiBaseFromPublicKey(pub) {
  if (!pub || typeof pub !== "string") return "https://sandbox.wompi.co/v1";
  return pub.startsWith("pub_prod_")
    ? "https://production.wompi.co/v1"
    : "https://sandbox.wompi.co/v1";
}

const TX_ID_RE = /^[\d-]+$/;

function sanitizeTransactionId(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 128 || !TX_ID_RE.test(s)) return null;
  return s;
}

/**
 * Consulta estado de transacción (llave pública).
 * @see https://docs.wompi.co/docs/colombia/transacciones/
 */
async function fetchWompiTransaction(publicKey, transactionId) {
  const id = sanitizeTransactionId(transactionId);
  if (!id) return { ok: false, status: 400, error: "transaction_id_inválido", data: null };
  const base = wompiApiBaseFromPublicKey(publicKey);
  try {
    const res = await axios.get(`${base}/transactions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${publicKey}` },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      logger.warn(`[wompi-rest] GET transaction ${res.status}`);
      return { ok: false, status: res.status, error: "wompi_fetch_failed", data: res.data };
    }
    return { ok: true, status: 200, data: res.data?.data ?? null };
  } catch (e) {
    logger.warn(`[wompi-rest] fetch transaction ${e.message}`);
    return { ok: false, status: 502, error: "network_error", data: null };
  }
}

module.exports = {
  wompiApiBaseFromPublicKey,
  sanitizeTransactionId,
  fetchWompiTransaction,
};
