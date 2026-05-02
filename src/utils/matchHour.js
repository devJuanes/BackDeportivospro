/** Normaliza HH:MM para columnas `match_hour`. */
function normalizeMatchHour(value) {
  const raw = String(value || "00:00").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "00:00";
  const hh = String(Math.min(23, Math.max(0, Number.parseInt(m[1], 10) || 0))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, Number.parseInt(m[2], 10) || 0))).padStart(2, "0");
  return `${hh}:${mm}`;
}

module.exports = { normalizeMatchHour };
