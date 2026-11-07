/**
 * futboolLogoService — compatibilidad historica.
 *
 * La implementacion real vive en `teamsService` (indice unico de equipos/ligas).
 * Este modulo mantiene los mismos exports para no romper imports existentes:
 *   src/utils/predictionDto.js, src/services/predictionEngine.js,
 *   src/services/aiForecastService.js, src/services/predictionAgentService.js,
 *   src/services/productionPublishService.js, src/jobs/liveMonitor.js,
 *   src/scripts/backfillProduction.js
 *
 * Ventajas del indice unico:
 *   - un solo parseo de los JSON de ligas (no dos caches en memoria)
 *   - resolucion difusa por indice de tokens (no escaneo lineal de ~1.200 equipos)
 *   - URLs de escudo precalculadas (sin fs.existsSync por request)
 */

const {
  DATA_ROOT,
  LOGOS_DIR,
  LOGOS_PUBLIC_PREFIX,
  DEFAULT_PUBLIC_API,
  NOISE_TOKENS,
  getPublicBaseUrl,
  ensurePublicLogoUrl,
  normalizeName,
  significantTokens,
  publicUrlForRelPath,
  resolveTeamLogoUrl,
  resolveLeagueLogoUrl,
  enrichPickLogos,
  getStats,
  rebuildIndex,
} = require("./teamsService");

/** Estado del indice de logos/equipos (mismo shape historico + campos nuevos). */
function getLogoStats() {
  const stats = getStats();
  return {
    leagues: stats.leagues,
    teamsWithLogo: stats.teamsWithLogo,
    logos: stats.logos,
    version: stats.version,
    loadedAt: stats.loadedAt,
    buildMs: stats.buildMs,
    ttlMs: stats.ttlMs,
    dataRoot: stats.dataRoot,
    publicPrefix: stats.publicPrefix,
    publicBaseUrl: stats.publicBaseUrl,
  };
}

/** Fuerza la reindexacion (sin reiniciar el server). */
function reloadLogoCache() {
  const index = rebuildIndex();
  return {
    leagues: index.leagues.length,
    teams: index.teams.length,
    logos: index.logoCount,
    version: index.version,
    loadedAt: new Date(index.loadedAt).toISOString(),
    buildMs: index.buildMs,
  };
}

module.exports = {
  DATA_ROOT,
  LOGOS_DIR,
  LOGOS_PUBLIC_PREFIX,
  DEFAULT_PUBLIC_API,
  NOISE_TOKENS,
  getPublicBaseUrl,
  ensurePublicLogoUrl,
  normalizeName,
  significantTokens,
  publicUrlForRelPath,
  resolveTeamLogoUrl,
  resolveLeagueLogoUrl,
  enrichPickLogos,
  getLogoStats,
  reloadLogoCache,
};
