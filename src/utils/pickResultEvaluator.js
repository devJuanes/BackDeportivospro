/**
 * Evalúa tip de fútbol vs marcador.
 * - matchFinished=false → solo cierra si el resultado YA está decidido (early win/lose).
 * - matchFinished=true → won/lost definitivos (o null si no se puede parsear).
 * Devuelve won | lost | void | null.
 */

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} pickText
 * @param {number} homeGoals
 * @param {number} awayGoals
 * @param {string} homeName
 * @param {string} awayName
 * @param {{ matchFinished?: boolean }} [opts]
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

  const overM = t.match(/(?:mas de|más de|over)\s*\+?\s*([\d,.]+)/);
  if (overM) {
    const line = Number.parseFloat(overM[1].replace(",", "."));
    if (Number.isFinite(line)) {
      if (total > line) return "won";
      if (matchFinished) return "lost";
      return null;
    }
  }

  const underM = t.match(/(?:menos de|under)\s*\+?\s*([\d,.]+)/);
  if (underM) {
    const line = Number.parseFloat(underM[1].replace(",", "."));
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

  // Resto de mercados: solo al final del partido.
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

  const victoryCue = /victoria|gana|triunfo\s+de|wins?\b|mercado\s+1x2|siguiente gol/.test(t);

  if (victoryCue) {
    if (mentionsHome && !mentionsAway) {
      return h > a ? "won" : "lost";
    }
    if (mentionsAway && !mentionsHome) {
      return a > h ? "won" : "lost";
    }
    if (/\blocal\b/.test(t) && !/visitante/.test(t)) {
      return h > a ? "won" : "lost";
    }
    if (/visitante/.test(t)) {
      return a > h ? "won" : "lost";
    }
  }

  return null;
}

module.exports = {
  evaluateFootballPickFromText,
};
