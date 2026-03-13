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

module.exports = {
  toInt,
  clamp,
  pickRandom,
  normalizeText,
  formatDateInTimezone,
  formatHourInTimezone,
  isoDateToCompact,
};
