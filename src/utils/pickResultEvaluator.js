/**
 * Evalúa tip de fútbol vs marcador.
 * Early settle (sin FT): overs/unders de GOLES, BTTS.
 * Corners/tarjetas: no se liquidan con goles (evita falsos won).
 * 1X2 / empate: solo a partido terminado.
 */

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCornersOrCardsMarket(t) {
  return /corner|esquin|tarjeta|card|amonest|faltas|fouls|tiros a puerta|shots on target|saques de banda/.test(
    t
  );
}

function isGoalsMarket(t) {
  if (isCornersOrCardsMarket(t)) return false;
  return /gol|goal|over|under|mas de|menos de|ambos marcan|btts|\d+\.\d+/.test(t);
}

/**
 * @returns {'won'|'lost'|'void'|null}
 */
function evaluateFootballPickFromText(
  pickText,
  homeGoals,
  awayGoals,
  homeName,
  awayName,
  opts = {}
) {
  const matchFinished = opts.matchFinished === true;
  const t = norm(pickText);
  const h = Number(homeGoals) || 0;
  const a = Number(awayGoals) || 0;
  const total = h + a;
  const hn = norm(homeName);
  const an = norm(awayName);

  if (!t) return null;

  // No liquidar corners/cards con marcador de goles (evita won falsos).
  if (isCornersOrCardsMarket(t)) {
    return null;
  }

  // Over / Más de X (goles)
  const overM =
    t.match(/(?:mas de|over)\s*\+?\s*([\d,.]+)/) ||
    t.match(/\bo\/u\s*\+?\s*([\d,.]+)/) ||
    t.match(/\+([\d,.]+)\s*(?:gol|goal)/);
  if (overM && (isGoalsMarket(t) || /mas de|over|o\/u/.test(t))) {
    const line = Number.parseFloat(String(overM[1]).replace(",", "."));
    if (Number.isFinite(line)) {
      if (total > line) return "won";
      if (matchFinished) return "lost";
      return null;
    }
  }

  // Under / Menos de X
  const underM = t.match(/(?:menos de|under)\s*\+?\s*([\d,.]+)/);
  if (underM) {
    const line = Number.parseFloat(String(underM[1]).replace(",", "."));
    if (Number.isFinite(line)) {
      if (total > line) return "lost";
      if (matchFinished) return total < line ? "won" : "lost";
      return null;
    }
  }

  if (/ambos\s+marcan|btts|gg\b/.test(t)) {
    const both = h > 0 && a > 0;
    const wantsNo =
      /\bno\b/.test(t.split(/ambos\s+marcan|btts/)[1] || "") ||
      /ambos\s+marcan\s*:\s*no|btts\s*no|no\s+ambos/.test(t);
    if (wantsNo) {
      if (both) return "lost";
      if (matchFinished) return "won";
      return null;
    }
    if (both) return "won";
    if (matchFinished) return "lost";
    return null;
  }

  // "Siguiente gol" / next goal — no se cierra early con total; solo FT si mencionan equipo.
  if (/siguiente gol|next goal|proximo gol/.test(t) && !matchFinished) {
    return null;
  }

  if (!matchFinished) return null;

  if (/\bempate\b|\bdraw\b/.test(t) && !/no\s+empate/.test(t)) {
    return h === a ? "won" : "lost";
  }

  if (/doble\s+oportunidad\s+1x|doble\s+chance\s+1x/.test(t)) {
    return h >= a ? "won" : "lost";
  }
  if (/doble\s+oportunidad\s+x2|doble\s+chance\s+x2/.test(t)) {
    return a >= h ? "won" : "lost";
  }
  if (/doble\s+oportunidad\s+12|doble\s+chance\s+12/.test(t)) {
    return h !== a ? "won" : "lost";
  }

  const homeFrag = hn.length >= 5 ? hn.slice(0, Math.min(18, hn.length)) : "";
  const awayFrag = an.length >= 5 ? an.slice(0, Math.min(18, an.length)) : "";
  const mentionsHome = homeFrag && t.includes(homeFrag);
  const mentionsAway = awayFrag && t.includes(awayFrag);
  const victoryCue = /victoria|gana|triunfo\s+de|wins?\b|mercado\s+1x2/.test(t);

  if (victoryCue) {
    if (mentionsHome && !mentionsAway) return h > a ? "won" : "lost";
    if (mentionsAway && !mentionsHome) return a > h ? "won" : "lost";
    if (/\blocal\b/.test(t) && !/visitante/.test(t)) return h > a ? "won" : "lost";
    if (/visitante/.test(t)) return a > h ? "won" : "lost";
  }

  return null;
}

module.exports = {
  evaluateFootballPickFromText,
  isCornersOrCardsMarket,
};
