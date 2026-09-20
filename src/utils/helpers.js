function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pickRandom(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function normalizeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function formatDateInTimezone(date = new Date(), timeZone = "America/Bogota") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function formatHourInTimezone(date = new Date(), timeZone = "America/Bogota") {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(date);
}

function isoDateToCompact(isoDate = "") {
  return String(isoDate).replace(/-/g, "");
}

/** Convierte DATE/ISO de MatuDB a YYYY-MM-DD en zona del proyecto. */
function normalizeMatchDate(value, timeZone = "America/Bogota") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      // MatuDB serializa DATE como ISO en UTC (ej. 2026-07-25T22:00:00Z = día 26 en CO).
      const shifted = new Date(parsed.getTime() + 12 * 60 * 60 * 1000);
      return formatDateInTimezone(shifted, timeZone);
    }
    return raw.slice(0, 10);
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

module.exports = {
  toInt,
  clamp,
  pickRandom,
  normalizeText,
  formatDateInTimezone,
  formatHourInTimezone,
  isoDateToCompact,
  normalizeMatchDate,
};
