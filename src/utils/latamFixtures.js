/**
 * Filtra fixtures de fútbol “Latinoamérica” para lotes dedicados (Colombia, Argentina, Ecuador, Perú, etc.).
 * Mantén alineado con `prediction-factory/src/utils/latamPickFilter.ts`.
 */

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const EURO_MARKERS = [
  "premier league",
  "champions league",
  "uefa champions",
  "europa league",
  "bundesliga",
  "la liga",
  "ligue 1",
  "eredivisie",
  "scottish premiership",
  "turkish super lig",
  "primeira liga",
];

const LATAM_MARKERS = [
  "colombia",
  "betplay",
  "dimayor",
  "primera b colombia",
  "categoria primera",
  "argentin",
  "liga profesional",
  "primera nacional",
  "lpf",
  "ecuador",
  "liga pro",
  "ligapro",
  "peru",
  "perú",
  "descentralizado",
  "conmebol",
  "libertadores",
  "sudamericana",
  "recopa",
  "brasileir",
  "brasileiro",
  "copa do brasil",
  "brazil",
  "brasil",
  "chile",
  "uruguay",
  "paraguay",
  "bolivia",
  "venezuela",
  "liga mx",
  "liga-mx",
  "mexican",
  "mexico",
  "costa rica",
  "guatemala",
  "honduras",
  "el salvador",
  "nicaragua",
  "panama",
  /** Perú — “Liga 1” puede aparecer solo así en APIs */
  "liga 1",
];

function hasEuroStrongSignal(text) {
  if (EURO_MARKERS.some((m) => text.includes(m))) return true;
  /** Serie A europea (Italia); Brasil suele traer “brasileir…” o país. */
  if (text.includes("serie a") && (text.includes("ital") || text.includes("tim"))) return true;
  return false;
}

function hasLatamSignal(text) {
  return LATAM_MARKERS.some((m) => text.includes(m));
}

function fixtureSearchText(fixture) {
  return normalizeText(`${fixture.league || ""} ${fixture.homeTeam || ""} ${fixture.awayTeam || ""}`);
}

function isLatamFootballFixture(fixture) {
  const text = fixtureSearchText(fixture);
  if (!text.trim()) return false;
  if (hasEuroStrongSignal(text)) return false;
  return hasLatamSignal(text);
}

function filterFootballFixturesLatam(fixtures) {
  if (!Array.isArray(fixtures)) return [];
  return fixtures.filter(isLatamFootballFixture);
}

module.exports = {
  isLatamFootballFixture,
  filterFootballFixturesLatam,
  fixtureSearchText,
};
