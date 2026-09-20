/**
 * Candado compartido para que dev + prod no ejecuten la fábrica a la vez sobre la misma BD.
 * FACTORY_INSTANCE_ID=dev | prod | local
 * FACTORY_ALLOW_PARALLEL=true → desactiva candado (solo pruebas).
 */
const os = require("node:os");
const { db } = require("../config/database");
const logger = require("../utils/logger");

const LOCK_KEY = "factory_pipeline";
const TTL_MS = Number.parseInt(process.env.FACTORY_LOCK_TTL_MS || `${12 * 60 * 1000}`, 10);

function instanceId() {
  return (
    String(process.env.FACTORY_INSTANCE_ID || "").trim() ||
    `${os.hostname()}-${process.pid}`
  );
}

function allowParallel() {
  return String(process.env.FACTORY_ALLOW_PARALLEL || "false").toLowerCase() === "true";
}

async function tryAcquireFactoryLock() {
  if (allowParallel()) {
    return { acquired: true, holder: instanceId(), skipped: "parallel_allowed" };
  }

  const holder = instanceId();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);

  try {
    const { data, error } = await db
      .from("factory_run_lock")
      .select("lock_key,holder,expires_at")
      .eq("lock_key", LOCK_KEY)
      .maybeSingle();

    if (error && !String(error.message || "").toLowerCase().includes("does not exist")) {
      logger.warn(`[factory-lock] lectura: ${error.message}`);
      return { acquired: true, holder, skipped: "lock_table_unavailable" };
    }

    if (data?.holder && data.holder !== holder) {
      const exp = data.expires_at ? new Date(data.expires_at).getTime() : 0;
      if (exp > now.getTime()) {
        return {
          acquired: false,
          holder: data.holder,
          reason: "locked_by_other_instance",
          expires_at: data.expires_at,
        };
      }
    }

    const upsert = await db.from("factory_run_lock").upsert(
      {
        lock_key: LOCK_KEY,
        holder,
        acquired_at: now.toISOString(),
        expires_at: expires.toISOString(),
      },
      { onConflict: "lock_key" }
    );

    if (upsert.error) {
      logger.warn(`[factory-lock] upsert: ${upsert.error.message}`);
      return { acquired: true, holder, skipped: "lock_write_failed" };
    }

    return { acquired: true, holder, expires_at: expires.toISOString() };
  } catch (error) {
    logger.warn(`[factory-lock] ${error.message}`);
    return { acquired: true, holder, skipped: "lock_error" };
  }
}

async function releaseFactoryLock() {
  if (allowParallel()) return;
  const holder = instanceId();
  try {
    await db
      .from("factory_run_lock")
      .eq("lock_key", LOCK_KEY)
      .eq("holder", holder)
      .delete();
  } catch {
    /* noop */
  }
}

module.exports = {
  tryAcquireFactoryLock,
  releaseFactoryLock,
  instanceId,
};
