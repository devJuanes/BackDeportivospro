/**
 * Play Store–safe copy: tips / consejos / pronósticos informativos.
 * Never surface gambling-house CTAs or "apuestas" product language in user-facing text.
 * Technical odds fields may remain for math elsewhere.
 */

const BANNED_PHRASE_REPLACEMENTS = [
  [/casas?\s+de\s+apuestas?/gi, "fuentes de cuotas"],
  [/casa\s+de\s+apuestas?/gi, "fuente de cuotas"],
  [/\bapuestas?\b/gi, "pronósticos"],
  [/\bbetting\b/gi, "tips"],
  [/\bgambling\b/gi, "análisis"],
  [/\bbet\s+now\b/gi, "ver tip"],
  [/\bplace\s+your\s+bet\b/gi, "consulta el tip"],
  [/\bbankroll\b/gi, "gestión"],
  [/\bstake\b/gi, "selección"],
  [/disciplina\s+de\s+banca/gi, "filtro de calidad"],
  [/valor\s+de\s+cuota\s+para\s+apostar/gi, "lectura de cuota implícita"],
];

function scrubPlayStoreText(value = "") {
  let out = String(value || "");
  for (const [pattern, replacement] of BANNED_PHRASE_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, " ").trim();
}

function playStoreSystemGuard() {
  return [
    "Eres analista deportivo de MatuPicks.",
    "Lenguaje Play Store safe: usa tips, consejos o pronósticos informativos.",
    "NUNCA uses: apuestas, casino, casa de apuestas, betting CTA, gana dinero, asegurado.",
    "Puedes mencionar cuotas solo como dato matemático/contexto, no como producto de juego.",
    "Responde solo JSON válido en español latinoamericano.",
  ].join(" ");
}

module.exports = {
  scrubPlayStoreText,
  playStoreSystemGuard,
};
