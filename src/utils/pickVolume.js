/**
 * Control de volumen: tipes premium, no spam.
 * - Tope diario por tier (free / vip)
 * - Máx. N tips por partido (default 2), el 2º solo si es mercado distinto y confianza alta
 */
const {
  normalizePickLabel,
  fixtureTierDedupeKey,
  marketDedupeKey,
} = require("./predictionDedupe");

function getMaxPicksPerMatch() {
  const n = Number.parseInt(process.env.FACTORY_MAX_PICKS_PER_MATCH || "2", 10);
  return Math.min(2, Math.max(1, Number.isFinite(n) ? n : 2));
}

function getDailyCap(tier = "free") {
  const free = Number.parseInt(process.env.FACTORY_DAILY_CAP_FREE || "40", 10);
  const vip = Number.parseInt(process.env.FACTORY_DAILY_CAP_VIP || "40", 10);
  const live = Number.parseInt(process.env.FACTORY_DAILY_CAP_LIVE || "18", 10);
  if (tier === "live") return Math.max(5, Number.isFinite(live) ? live : 18);
  const n = tier === "vip" ? vip : free;
  return Math.max(5, Number.isFinite(n) ? n : 40);
}

function getSecondPickMinConfidence(tier = "free") {
  const fallback = tier === "vip" ? "78" : "72";
  const envKey =
    tier === "vip"
      ? process.env.FACTORY_SECOND_PICK_MIN_CONFIDENCE_VIP
      : process.env.FACTORY_SECOND_PICK_MIN_CONFIDENCE_FREE;
  const n = Number.parseInt(envKey || process.env.FACTORY_SECOND_PICK_MIN_CONFIDENCE || fallback, 10);
  return Number.isFinite(n) ? n : Number(fallback);
}

/** Familia de mercado para no duplicar el mismo ángulo en un partido. */
function marketFamily(label = "") {
  const p = normalizePickLabel(label);
  if (!p) return "other";
  if (/\b(btts|ambos|gg|ambas)\b/.test(p) || /marcan/.test(p)) return "btts";
  if (/corner|esquin|tiro(s)? de esquina/.test(p)) return "corners";
  if (/tarjeta|card|amonest/.test(p)) return "cards";
  if (/handicap|asian|asiatico/.test(p)) return "handicap";
  if (/over|under|mas de|menos de|\d+\.\d+/.test(p)) return "totals";
  if (/victoria|1x2|gana |win |doble oportunidad|1x|x2/.test(p)) return "1x2";
  if (/set|game|break|ace/.test(p)) return "tennis";
  if (/punto|quarter|rebote|triple/.test(p)) return "basket";
  return "other";
}

function pickConfidence(pick) {
  return Number(pick?.confidence) || 0;
}

function pickLabel(pick) {
  return pick?.prediction || pick?.pick_text || pick?.pick || "";
}

function realExistingPicks(existingPicks = []) {
  return (Array.isArray(existingPicks) ? existingPicks : []).filter(
    (p) => p && !p._plant && pickLabel(p)
  );
}

/**
 * ¿Se puede añadir este tip al partido?
 * 1º: siempre (si pasa quality gate fuera).
 * 2º: solo si confianza alta, mercado distinto (texto) y familia distinta.
 */
function shouldAcceptPickForFixture({ existingPicks = [], candidate, tier = "free" }) {
  const max = getMaxPicksPerMatch();
  const list = realExistingPicks(existingPicks);
  const placeholders = (Array.isArray(existingPicks) ? existingPicks : []).length - list.length;
  if (list.length + Math.max(0, placeholders) >= max) return false;

  const candLabel = normalizePickLabel(pickLabel(candidate));
  if (candLabel && list.some((p) => normalizePickLabel(pickLabel(p)) === candLabel)) {
    return false;
  }

  if (list.length === 0 && placeholders === 0) return true;

  const conf = pickConfidence(candidate);
  if (list.length >= 1 && conf < getSecondPickMinConfidence(tier)) return false;

  const fam = marketFamily(pickLabel(candidate));
  const used = new Set(list.map((p) => marketFamily(pickLabel(p))));
  if (used.has(fam)) return false;

  return true;
}

/**
 * De una lista de candidatos (mismo tier), deja como máximo N por partido,
 * priorizando confianza y diversidad de mercado.
 */
function selectTopPicksPerFixture(picks = [], tier = "free") {
  const max = getMaxPicksPerMatch();
  const byFixture = new Map();
  for (const pick of picks || []) {
    const key = fixtureTierDedupeKey(pick);
    if (!key) continue;
    if (!byFixture.has(key)) byFixture.set(key, []);
    byFixture.get(key).push(pick);
  }

  const out = [];
  for (const group of byFixture.values()) {
    const sorted = [...group].sort((a, b) => pickConfidence(b) - pickConfidence(a));
    const kept = [];
    for (const candidate of sorted) {
      if (shouldAcceptPickForFixture({ existingPicks: kept, candidate, tier })) {
        kept.push(candidate);
      }
      if (kept.length >= max) break;
    }
    out.push(...kept);
  }
  return out;
}

function isSettledPick(pick) {
  const s = String(pick?.state || pick?.status || pick?.outcome || "").toLowerCase();
  return ["won", "lost", "void", "ganada", "perdida", "anulada"].includes(s);
}

function pickRank(pick) {
  let rank = pickConfidence(pick);
  if (isSettledPick(pick)) rank += 1000;
  return rank;
}

/**
 * Para el feed: 1 mercado por texto + máx. 2 familias distintas por partido.
 * No aplica el umbral de confianza del 2º tip (eso es solo al generar).
 */
function collapsePicksForDisplay(picks = []) {
  const max = getMaxPicksPerMatch();
  const byMarket = new Map();
  for (const pick of picks || []) {
    const mk = marketDedupeKey(pick);
    if (!mk || mk.endsWith("|")) continue;
    const prev = byMarket.get(mk);
    if (!prev || pickRank(pick) > pickRank(prev)) {
      byMarket.set(mk, pick);
    }
  }

  const byFixture = new Map();
  for (const pick of byMarket.values()) {
    const fk = fixtureTierDedupeKey(pick);
    if (!fk) continue;
    if (!byFixture.has(fk)) byFixture.set(fk, []);
    byFixture.get(fk).push(pick);
  }

  const out = [];
  for (const group of byFixture.values()) {
    const settled = group.filter(isSettledPick);
    const pending = group
      .filter((p) => !isSettledPick(p))
      .sort((a, b) => pickRank(b) - pickRank(a));
    const kept = [...settled];
    const usedFam = new Set(settled.map((p) => marketFamily(pickLabel(p))));
    const usedLabel = new Set(settled.map((p) => normalizePickLabel(pickLabel(p))));
    for (const candidate of pending) {
      if (kept.length >= Math.max(max, settled.length)) break;
      const fam = marketFamily(pickLabel(candidate));
      const lab = normalizePickLabel(pickLabel(candidate));
      if (usedLabel.has(lab) || usedFam.has(fam)) continue;
      usedFam.add(fam);
      usedLabel.add(lab);
      kept.push(candidate);
    }
    out.push(...kept);
  }
  return out;
}

/** Incrementa contador en Map fixtureKey → count. */
function bumpFixtureCount(map, key) {
  if (!key || !map) return;
  map.set(key, (map.get(key) || 0) + 1);
}

module.exports = {
  getMaxPicksPerMatch,
  getDailyCap,
  getSecondPickMinConfidence,
  marketFamily,
  shouldAcceptPickForFixture,
  selectTopPicksPerFixture,
  collapsePicksForDisplay,
  isSettledPick,
  bumpFixtureCount,
  pickLabel,
};
