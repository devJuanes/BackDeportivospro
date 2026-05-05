function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function cap(value, max) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function hasCoreTeams(text, home, away) {
  const t = cleanText(text).toLowerCase();
  const h = cleanText(home).toLowerCase();
  const a = cleanText(away).toLowerCase();
  if (!t || !h || !a) return false;
  return t.includes(h) && t.includes(a);
}

function buildPredictionSeo(payload = {}) {
  const brand = cleanText(process.env.SEO_BRAND_NAME || "MatuPicks");
  const home = cleanText(payload.homeTeam?.name || payload.home_team_name || payload.team_a || "Local");
  const away = cleanText(payload.awayTeam?.name || payload.away_team_name || payload.team_b || "Visitante");
  const league = cleanText(payload.league || "Fútbol");
  const pick = cleanText(payload.prediction || payload.pick_text || "análisis del partido");
  const date = cleanText(payload.date || payload.match_date || "hoy");
  const tier = cleanText(payload.tier || "free").toLowerCase();
  const isVip = tier === "vip";

  const generatedTitle = cap(
    `Pronóstico ${home} vs ${away} hoy: ${pick} | ${league} | ${brand}`,
    68
  );
  const generatedDescription = cap(
    `Pronóstico de ${home} vs ${away} para ${date} en ${league}. Pick ${isVip ? "VIP" : "gratis"}: ${pick}. Análisis previo, contexto y datos clave en ${brand}.`,
    165
  );

  const incomingTitle = cleanText(payload.seo_title);
  const incomingDescription = cleanText(payload.seo_description);

  const keepIncomingTitle =
    incomingTitle.length >= 35 &&
    incomingTitle.length <= 72 &&
    hasCoreTeams(incomingTitle, home, away);
  const keepIncomingDescription =
    incomingDescription.length >= 110 &&
    incomingDescription.length <= 175 &&
    hasCoreTeams(incomingDescription, home, away);

  return {
    seo_title: keepIncomingTitle ? incomingTitle : generatedTitle,
    seo_description: keepIncomingDescription ? incomingDescription : generatedDescription,
  };
}

module.exports = {
  buildPredictionSeo,
};
