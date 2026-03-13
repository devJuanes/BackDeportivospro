const { db } = require("../config/database");

async function listSources(limit = 200) {
  const { data, error } = await db
    .from("source_registry")
    .select("*")
    .order("priority", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(error.message || "Error listando fuentes");
  }
  return data || [];
}

async function getSourceByUrl(url) {
  const { data, error } = await db
    .from("source_registry")
    .select("*")
    .eq("url", url)
    .limit(1);
  if (error) {
    throw new Error(error.message || "Error obteniendo fuente");
  }
  return data?.[0] || null;
}

async function createSource(payload) {
  const { data, error } = await db.from("source_registry").insert(payload);
  if (error) {
    throw new Error(error.message || "Error creando fuente");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function updateSource(url, payload) {
  const { data, error } = await db
    .from("source_registry")
    .eq("url", url)
    .update(payload);
  if (error) {
    throw new Error(error.message || "Error actualizando fuente");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function upsertSourceByUrl(payload) {
  const existing = await getSourceByUrl(payload.url);
  if (!existing) {
    return createSource(payload);
  }
  return updateSource(payload.url, {
    name: payload.name,
    sport: payload.sport,
    is_active: payload.is_active,
    priority: payload.priority,
    notes: payload.notes,
  });
}

async function listActiveSourcesBySport(sport) {
  const { data, error } = await db
    .from("source_registry")
    .select("*")
    .eq("is_active", true)
    .eq("sport", sport)
    .order("priority", { ascending: true })
    .limit(100);
  if (error) {
    throw new Error(error.message || "Error listando fuentes activas");
  }
  return data || [];
}

function scoreToTier(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "E";
}

async function updateSourceHealth(url, probe) {
  const row = await getSourceByUrl(url);
  if (!row) {
    return null;
  }
  const success = probe.ok ? 1 : 0;
  const fail = probe.ok ? 0 : 1;
  const nextSuccess = (row.success_count || 0) + success;
  const nextFail = (row.fail_count || 0) + fail;
  const total = nextSuccess + nextFail;
  const successRate = total > 0 ? nextSuccess / total : 0.5;
  const latencyPenalty = Math.min((probe.latency_ms || 0) / 10000, 0.25);
  const statusPenalty = probe.ok ? 0 : 0.2;
  const scoreRaw = (successRate * 100) * (1 - latencyPenalty - statusPenalty);
  const healthScore = Math.max(0, Math.min(100, Math.round(scoreRaw)));

  const { data, error } = await db
    .from("source_registry")
    .eq("url", url)
    .update({
      health_score: healthScore,
      success_count: nextSuccess,
      fail_count: nextFail,
      last_latency_ms: probe.latency_ms || null,
      last_status: probe.status || null,
      last_checked_at: new Date().toISOString(),
      reliability_tier: scoreToTier(healthScore),
    });
  if (error) {
    throw new Error(error.message || "Error actualizando salud de fuente");
  }
  return Array.isArray(data) ? data[0] : data;
}

async function listTopReliableSources(sport, limit = 10) {
  const { data, error } = await db
    .from("source_registry")
    .select("*")
    .eq("is_active", true)
    .eq("sport", sport)
    .order("health_score", { ascending: false })
    .order("priority", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(error.message || "Error listando top fuentes");
  }
  return data || [];
}

async function listActiveSourcesBySportAndTiers(sport, tiers = ["A", "B", "C"]) {
  const { data, error } = await db
    .from("source_registry")
    .select("*")
    .eq("is_active", true)
    .eq("sport", sport)
    .in("reliability_tier", tiers)
    .order("health_score", { ascending: false })
    .order("priority", { ascending: true })
    .limit(100);
  if (error) {
    throw new Error(error.message || "Error listando fuentes por tier");
  }
  return data || [];
}

module.exports = {
  listSources,
  getSourceByUrl,
  createSource,
  updateSource,
  upsertSourceByUrl,
  listActiveSourcesBySport,
  updateSourceHealth,
  listTopReliableSources,
  listActiveSourcesBySportAndTiers,
};
