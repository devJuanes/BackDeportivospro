const axios = require("axios");
const { DEFAULT_SOURCE_REGISTRY } = require("../config/sourceRegistry");
const {
  listSources,
  upsertSourceByUrl,
  listActiveSourcesBySport,
  updateSourceHealth,
  listTopReliableSources,
  listActiveSourcesBySportAndTiers,
} = require("../models/sourceModel");
const logger = require("../utils/logger");

function toSourceName(url) {
  try {
    const host = new URL(url).hostname.replace("www.", "");
    return host;
  } catch {
    return url;
  }
}

function toHost(value = "") {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(value).toLowerCase().replace(/^www\./, "");
  }
}

async function syncDefaultSources() {
  const results = [];
  let priority = 1;
  for (const url of DEFAULT_SOURCE_REGISTRY) {
    const row = await upsertSourceByUrl({
      url,
      name: toSourceName(url),
      sport: "football",
      is_active: true,
      priority: priority++,
      notes: "Catálogo base de fuentes DeportivosPro",
    });
    results.push(row);
  }
  logger.info(`Fuentes sincronizadas: ${results.length}`);
  return results;
}

async function probeSource(url) {
  const startedAt = Date.now();
  try {
    const response = await axios.get(url, { timeout: 8000 });
    return {
      url,
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: error.response?.status || 0,
      latency_ms: Date.now() - startedAt,
      error: error.message,
    };
  }
}

async function getFactorySourcesStatus(sport = "football") {
  const sources = await listActiveSourcesBySport(sport);
  const probes = await Promise.all(sources.slice(0, 10).map((s) => probeSource(s.url)));
  const topReliable = await listTopReliableSources(sport, 10);
  return {
    sport,
    total_active_sources: sources.length,
    probes,
    top_reliable: topReliable,
  };
}

async function getPredictionSourcePolicy(sport = "football") {
  const [vipCandidates, freeCandidates, fallback] = await Promise.all([
    listActiveSourcesBySportAndTiers(sport, ["A", "B"]),
    listActiveSourcesBySportAndTiers(sport, ["A", "B", "C"]),
    listActiveSourcesBySport(sport),
  ]);

  const vipHosts = vipCandidates.map((row) => toHost(row.url));
  const freeHosts = freeCandidates.map((row) => toHost(row.url));
  const fallbackHosts = fallback.map((row) => toHost(row.url));

  return {
    sport,
    vip_hosts: vipHosts.length > 0 ? vipHosts : fallbackHosts,
    free_hosts: freeHosts.length > 0 ? freeHosts : fallbackHosts,
    strict_vip: vipHosts.length > 0,
  };
}

async function refreshSourcesHealth(sport = "football", limit = 10) {
  const sources = await listActiveSourcesBySport(sport);
  const subset = sources.slice(0, limit);
  const probes = await Promise.all(subset.map((s) => probeSource(s.url)));
  const updates = [];
  for (const probe of probes) {
    try {
      const updated = await updateSourceHealth(probe.url, probe);
      if (updated) {
        updates.push(updated);
      }
    } catch (error) {
      logger.warn(`No se pudo actualizar salud de fuente ${probe.url}: ${error.message}`);
    }
  }
  return updates;
}

module.exports = {
  listSources,
  syncDefaultSources,
  getFactorySourcesStatus,
  refreshSourcesHealth,
  getPredictionSourcePolicy,
  toHost,
};
