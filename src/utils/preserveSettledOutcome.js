/**
 * Nunca degradar un tip ya liquidado (won/lost/void) a pending.
 * Convención abetlive (compatible Flutter actual, sin cambiar schema):
 *   state = "ended" | "live" | "pending"
 *   outcome = "won" | "lost" | "void" | "pending" | null
 * El resultado vive en `outcome`; `state=ended` saca el tip del feed en vivo.
 */

const SETTLED = new Set(["won", "lost", "void", "ganada", "perdida"]);

function normalizeResult(value) {
  const v = String(value || "").toLowerCase().trim();
  if (v === "ganada" || v === "ganado" || v === "acertada" || v === "acertado") return "won";
  if (v === "perdida" || v === "perdido" || v === "fallada" || v === "fallado") return "lost";
  if (v === "anulada" || v === "nula" || v === "push") return "void";
  if (SETTLED.has(v)) return v === "ganada" ? "won" : v === "perdida" ? "lost" : v;
  return "";
}

function settledFromRow(row = {}) {
  return (
    normalizeResult(row.outcome) ||
    normalizeResult(row.state) ||
    normalizeResult(row.status) ||
    ""
  );
}

function isSettledResult(value) {
  return Boolean(normalizeResult(value));
}

/**
 * Si el tip ya está ganado/perdido/anulado, conserva ese resultado.
 * Para live cerrado: state=ended + outcome=won|lost|void (Flutter lee outcome primero).
 */
function preserveSettledOutcome(row, nextOutcome, nextState, { liveStyle = false } = {}) {
  const locked = settledFromRow(row);
  if (locked) {
    if (liveStyle || String(row.state || "").toLowerCase() === "ended" || row.live_ended === true) {
      return {
        outcome: locked,
        state: locked === "void" ? "void" : "ended",
        locked: true,
      };
    }
    // Tips free/vip: el resultado va en state.
    return {
      outcome: locked,
      state: locked,
      locked: true,
    };
  }

  const out = normalizeResult(nextOutcome);
  let state = String(nextState || "ended").toLowerCase();

  if (out === "won" || out === "lost" || out === "void") {
    // Live: cerrar con ended + outcome. Free/vip: state = resultado.
    if (liveStyle || state === "ended" || state === "live") {
      return { outcome: out, state: out === "void" ? "void" : "ended", locked: false };
    }
    return { outcome: out, state: out, locked: false };
  }

  // Sin liquidar: no inventar won. pending/ended/live según nextState.
  if (state === "won" || state === "lost") {
    state = "ended";
  }
  return {
    outcome: String(nextOutcome || "pending").toLowerCase() || "pending",
    state: state || "ended",
    locked: false,
  };
}

/**
 * Si el patch degradaría un tip liquidado, lo corrige in-place.
 * Devuelve true si el update debe abortarse por completo (solo scores).
 */
function hardenSettledPatch(current, patch, { liveTable = false } = {}) {
  const locked = settledFromRow(current || {});
  if (!locked) return false;

  if (patch.state != null) {
    const ns = String(patch.state).toLowerCase();
    if (!["won", "lost", "void", "ended", "ganada", "perdida"].includes(ns) || ns === "pending" || ns === "live") {
      patch.state = liveTable ? (locked === "void" ? "void" : "ended") : locked;
    }
  }
  if (patch.outcome != null) {
    const no = String(patch.outcome).toLowerCase();
    if (!["won", "lost", "void"].includes(no)) {
      patch.outcome = locked;
    }
  } else if (liveTable) {
    patch.outcome = locked;
    if (patch.state == null) patch.state = locked === "void" ? "void" : "ended";
  }
  if (patch.status != null) {
    const ns = String(patch.status).toLowerCase();
    if (!["won", "lost", "void"].includes(ns)) {
      patch.status = locked;
    }
  }
  return false;
}

module.exports = {
  SETTLED,
  normalizeResult,
  settledFromRow,
  isSettledResult,
  preserveSettledOutcome,
  hardenSettledPatch,
};
