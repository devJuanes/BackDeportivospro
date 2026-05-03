/**
 * Evalúa resultado de un pick de fútbol vs marcador final (heurística sobre texto libre).
 * Devuelve won | lost | null (null = no auto-cerrar; revisión manual).
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
 * @returns {'won'|'lost'|null}
 */
function evaluateFootballPickFromText(pickText, homeGoals, awayGoals, homeName, awayName) {
  const t = norm(pickText);
  const h = Number(homeGoals) || 0;
  const a = Number(awayGoals) || 0;
  const total = h + a;
  const hn = norm(homeName);
  const an = norm(awayName);

  if (!t) return null;

  const overM = t.match(/(?:mas de|más de|over)\s+([\d,.]+)/);
  if (overM) {
    const line = Number.parseFloat(overM[1].replace(",", "."));
    if (Number.isFinite(line)) {
      return total > line ? "won" : "lost";
    }
  }

  const underM = t.match(/(?:menos de|under)\s+([\d,.]+)/);
  if (underM) {
    const line = Number.parseFloat(underM[1].replace(",", "."));
    if (Number.isFinite(line)) {
      return total < line ? "won" : "lost";
    }
  }

  if (/\bempate\b|\bdraw\b/.test(t) && !/no\s+empate/.test(t)) {
    return h === a ? "won" : "lost";
  }

  if (/ambos\s+marcan/.test(t)) {
    const both = h > 0 && a > 0;
    if (/\bno\b/.test(t.split("ambos marcan")[1] || "") || /\bno\b/.test(t.slice(0, t.indexOf("ambos marcan")))) {
      return !both ? "won" : "lost";
    }
    return both ? "won" : "lost";
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
