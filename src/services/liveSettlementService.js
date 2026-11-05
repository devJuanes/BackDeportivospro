/**
 * Liquidación y limpieza del ciclo de vida de señales live (`abetlive`).
 * Se invoca desde el cron live_monitor (y opcionalmente prediction_tracking).
 * Play Store safe: logs sin CTAs de juego.
 */
const logger = require("../utils/logger");
const { db } = require("../config/database");
const { stripCjkText } = require("../utils/playStoreSafe");
const {
  getActiveLiveRows,
  getUnresolvedEndedLiveRows,
  finalizeLivePrediction,
  updateLiveScore,
  finalizeStaleLiveByCalendar,
  todayLiveDate,
  rowMatchDate,
} = require("../models/liveModel");
const { getFixturesByDateSport } = require("../models/fixtureModel");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
const {
  findLiveMatch,
  teamsStrictMatch,
  isPlausibleScore,
  normalizeSport,
} = require("../utils/liveScoreMatch");
const { preserveSettledOutcome, settledFromRow } = require("../utils/preserveSettledOutcome");
const { updatePredictionLiveData, updatePredictionState } = require("../models/dpPredictionModel");

const FINISHED_STATUSES = new Set(["post", "final", "ft", "finished", "ended", "complete", "completed"]);

function isFinishedStatus(status) {
  return FINISHED_STATUSES.has(String(status || "").toLowerCase());
}

async function findCachedFixture(sport, matchDate, home, away) {
  if (!matchDate) return null;
  try {
    const rows = await getFixturesByDateSport(matchDate, sport || "football");
    return (
      (rows || []).find(
        (f) =>
          (teamsStrictMatch(f.team_a, home) && teamsStrictMatch(f.team_b, away)) ||
          (teamsStrictMatch(f.team_a, away) && teamsStrictMatch(f.team_b, home))
      ) || null
    );
  } catch (error) {
    const msg = String(error.message || "");
    if (!msg.toLowerCase().includes("fetch failed") && !msg.toLowerCase().includes("enotfound")) {
      logger.warn(`[live-settle] caché fixtures: ${msg}`);
    }
    return null;
  }
}

async function syncLinkedPrediction(row, { finished, outcome, homeGoals, awayGoals, minute, isLive }) {
  const predId = row.prediction_id;
  if (!predId) return;
  const preserved = preserveSettledOutcome(row, outcome, outcome);
  const finalOutcome = preserved.outcome;
  try {
    await updatePredictionLiveData(predId, {
      home_goals: homeGoals,
      away_goals: awayGoals,
      minute: minute || 0,
      is_live: Boolean(isLive) && !finished && !preserved.locked,
      status: finished || preserved.locked ? finalOutcome || "pending" : isLive ? "live" : undefined,
    });
    if (
      (finished || preserved.locked) &&
      (finalOutcome === "won" || finalOutcome === "lost" || finalOutcome === "pending")
    ) {
      // Nunca bajar won/lost a pending en dp_predictions.
      if (!(settledFromRow(row) && finalOutcome === "pending")) {
        await updatePredictionState(predId, finalOutcome);
      }
      await updatePredictionLiveData(predId, {
        is_live: false,
        status: settledFromRow(row) || finalOutcome,
      });
    }
  } catch (error) {
    logger.warn(`[live-settle] sync dp_predictions ${predId}: ${error.message}`);
  }
}

async function completeTrackingJobsForLive(abetliveId) {
  if (!abetliveId) return;
  try {
    await db
      .from("dp_tracking_jobs")
      .eq("abetlive_id", abetliveId)
      .eq("status", "active")
      .update({
        status: "completed",
        next_check_at: null,
        updated_at: new Date().toISOString(),
      });
  } catch {
    /* columna abetlive_id puede no existir aún */
  }
}

/**
 * Evalúa outcome cuando hay marcador final; si no se puede inferir → pending.
 */
function resolveOutcome(row, homeGoals, awayGoals, matchFinished = true) {
  const sport = String(row.sport || "football").toLowerCase();
  if (sport !== "football" && sport !== "soccer") {
    return "pending";
  }
  const evaluated = evaluateFootballPickFromText(
    row.prediction,
    homeGoals,
    awayGoals,
    row.home_team_name,
    row.away_team_name,
    { matchFinished }
  );
  return evaluated || "pending";
}

/**
 * Refresca / liquida tips live activos del día.
 * @param {Array} activeLiveMatches partidos aún "in" (ESPN); puede estar vacío si DNS falla
 * @param {{ allowGoneFromBoard?: boolean }} options si false, no cierra por ausencia en scoreboard
 */
async function settleActiveLiveTips(activeLiveMatches = [], options = {}) {
  const allowGoneFromBoard = options.allowGoneFromBoard !== false;
  const today = todayLiveDate();
  const activePairs = new Set(
    (activeLiveMatches || []).map((m) => `${m.homeTeam}|${m.awayTeam}`)
  );

  let rows = [];
  try {
    rows = await getActiveLiveRows(150);
  } catch (error) {
    logger.warn(`[live-settle] lectura activos: ${error.message}`);
    return { settled: 0, refreshed: 0, staleClosed: 0, repaired: 0 };
  }

  // Re-liquidar tips ya "ended" pero con outcome=pending (bug histórico).
  let repaired = 0;
  try {
    const stuck = await getUnresolvedEndedLiveRows(200);
    for (const row of stuck) {
      if (settledFromRow(row)) continue;
      const hg = Number(row.home_goals) || 0;
      const ag = Number(row.away_goals) || 0;
      if (!isPlausibleScore(row.sport, hg, ag, Number(row.minute) || 90)) continue;
      const raw = resolveOutcome(row, hg, ag, true);
      if (raw !== "won" && raw !== "lost" && raw !== "void") continue;
      await finalizeLivePrediction(row.id, {
        outcome: raw,
        state: "ended",
        minute: Number(row.minute) || 90,
        home_goals: hg,
        away_goals: ag,
      });
      await syncLinkedPrediction(row, {
        finished: true,
        outcome: raw,
        homeGoals: hg,
        awayGoals: ag,
        minute: Number(row.minute) || 90,
        isLive: false,
      });
      repaired += 1;
    }
  } catch (error) {
    logger.warn(`[live-settle] repair ended+pending: ${error.message}`);
  }

  let settled = 0;
  let refreshed = 0;
  let staleClosed = 0;

  for (const row of rows) {
    const home = row.home_team_name;
    const away = row.away_team_name;
    const matchDate = rowMatchDate(row) || today;
    const pairKey = `${home}|${away}`;

    // Día anterior: cerrar feed live SIN borrar resultado ganado/perdido.
    if (matchDate < today) {
      const locked = settledFromRow(row);
      const hg = Number(row.home_goals) || 0;
      const ag = Number(row.away_goals) || 0;
      let outcome = locked || null;
      if (!outcome && (hg + ag > 0 || Number(row.minute) >= 70)) {
        outcome = resolveOutcome(row, hg, ag, true);
        if (outcome === "pending") outcome = null;
      }
      await finalizeLivePrediction(row.id, {
        outcome: outcome || locked || "pending",
        state: "ended",
        home_goals: hg,
        away_goals: ag,
        minute: row.minute,
      });
      await completeTrackingJobsForLive(row.id);
      staleClosed += 1;
      continue;
    }

    const liveHit = findLiveMatch(activeLiveMatches, home, away, row.sport);
    if (liveHit) {
      try {
        const hg = Number(liveHit.homeGoals) || 0;
        const ag = Number(liveHit.awayGoals) || 0;
        const sport = normalizeSport(row.sport);
        const early =
          sport === "football"
            ? evaluateFootballPickFromText(row.prediction, hg, ag, home, away, {
                matchFinished: false,
              })
            : null;
        if (early === "won" || early === "lost" || early === "void") {
          // Liquidación temprana: cerrar tip (ended + outcome). NUNCA volver a pending.
          await finalizeLivePrediction(row.id, {
            outcome: early,
            state: "ended",
            minute: liveHit.minute,
            home_goals: hg,
            away_goals: ag,
          });
          await syncLinkedPrediction(row, {
            finished: true,
            outcome: early,
            homeGoals: hg,
            awayGoals: ag,
            minute: liveHit.minute,
            isLive: false,
          });
          settled += 1;
        } else {
          const nextState =
            row.state === "won" || row.state === "lost" ? row.state : "live";
          await updateLiveScore(
            row.id,
            {
              minute: liveHit.minute,
              home_goals: hg,
              away_goals: ag,
              state: nextState,
              outcome: row.outcome || null,
            },
            { ai_rationale: row.ai_rationale }
          );
          await syncLinkedPrediction(row, {
            finished: false,
            homeGoals: hg,
            awayGoals: ag,
            minute: liveHit.minute,
            isLive: true,
          });
          refreshed += 1;
        }
      } catch (error) {
        logger.warn(`[live-settle] refresh ${row.id}: ${error.message}`);
      }
      continue;
    }

    // Marcador imposible (leak cross-sport): limpiar en vez de mostrar basura.
    const curHg = Number(row.home_goals) || 0;
    const curAg = Number(row.away_goals) || 0;
    const curMin = Number(row.minute) || 0;
    if (!isPlausibleScore(row.sport, curHg, curAg, curMin) && (curHg || curAg || curMin)) {
      try {
        await updateLiveScore(row.id, {
          minute: 0,
          home_goals: 0,
          away_goals: 0,
          state: row.state === "won" || row.state === "lost" ? row.state : "live",
          outcome: row.outcome || null,
        });
        refreshed += 1;
      } catch (error) {
        logger.warn(`[live-settle] clear bad score ${row.id}: ${error.message}`);
      }
    }

    // No está en el scoreboard en vivo: mirar caché / estado final.
    const fixture = await findCachedFixture(row.sport, matchDate, home, away);
    const fxStatus = String(fixture?.status || "").toLowerCase();
    const finished = fixture && isFinishedStatus(fxStatus);

    if (finished) {
      const hg = Number(fixture.home_goals) || 0;
      const ag = Number(fixture.away_goals) || 0;
      if (!isPlausibleScore(row.sport, hg, ag, Number(fixture.minute) || 90)) {
        continue;
      }
      const rawOutcome = resolveOutcome(row, hg, ag, true);
      const preserved = preserveSettledOutcome(row, rawOutcome, rawOutcome === "pending" ? "ended" : rawOutcome);
      await finalizeLivePrediction(row.id, {
        outcome: preserved.outcome,
        state: preserved.state,
        minute: Number(fixture.minute) || row.minute || 90,
        home_goals: hg,
        away_goals: ag,
      });
      await syncLinkedPrediction(row, {
        finished: true,
        outcome: preserved.outcome,
        homeGoals: hg,
        awayGoals: ag,
        minute: Number(fixture.minute) || 90,
        isLive: false,
      });
      await completeTrackingJobsForLive(row.id);
      settled += 1;
      continue;
    }

    // Sin fuente live y sin final confirmado: solo si el monitor pasó scoreboard real.
    const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
    const ageMs = createdMs ? Date.now() - createdMs : 0;
    const providersResponded = Array.isArray(activeLiveMatches);
    const goneFromBoard = providersResponded && !activePairs.has(pairKey);

    if (allowGoneFromBoard && goneFromBoard && ageMs >= 3 * 60 * 60 * 1000) {
      const hg = Number(fixture?.home_goals ?? row.home_goals) || 0;
      const ag = Number(fixture?.away_goals ?? row.away_goals) || 0;
      const useScores = isPlausibleScore(row.sport, hg, ag, row.minute);
      const rawOutcome =
        fixture && isFinishedStatus(fxStatus) && useScores
          ? resolveOutcome(row, hg, ag)
          : "pending";
      const preserved = preserveSettledOutcome(row, rawOutcome, "ended");
      await finalizeLivePrediction(row.id, {
        outcome: preserved.outcome,
        state: preserved.state,
        home_goals: useScores ? hg : 0,
        away_goals: useScores ? ag : 0,
      });
      await syncLinkedPrediction(row, {
        finished: true,
        outcome: preserved.outcome,
        homeGoals: useScores ? hg : 0,
        awayGoals: useScores ? ag : 0,
        minute: row.minute,
        isLive: false,
      });
      await completeTrackingJobsForLive(row.id);
      settled += 1;
    }
  }

  return { settled, refreshed, staleClosed, repaired, today };
}

/**
 * Pasada completa: limpieza por calendario + settle de activos.
 * @param {Array} activeLiveMatches
 * @param {{ allowGoneFromBoard?: boolean }} options
 */
async function runLiveLifecycleOnce(activeLiveMatches = [], options = {}) {
  const { isAutoSettleEnabled } = require("./factoryService");
  if (!isAutoSettleEnabled()) {
    return { calendarClosed: 0, settled: 0, refreshed: 0, staleClosed: 0, skipped: true };
  }

  let calendar = { closed: 0 };
  try {
    calendar = await finalizeStaleLiveByCalendar(300);
  } catch (error) {
    logger.warn(`[live-settle] cleanup calendario: ${error.message}`);
  }

  let settle = { settled: 0, refreshed: 0, staleClosed: 0, repaired: 0 };
  try {
    settle = await settleActiveLiveTips(activeLiveMatches, options);
  } catch (error) {
    logger.warn(`[live-settle] ciclo: ${error.message}`);
  }

  const closed =
    (calendar.closed || 0) + (settle.staleClosed || 0) + (settle.settled || 0) + (settle.repaired || 0);
  if (closed > 0 || settle.refreshed > 0) {
    logger.info(
      `[live-settle] cerrados=${closed}, reparados=${settle.repaired || 0}, actualizados=${settle.refreshed || 0}, dia=${calendar.today || settle.today || todayLiveDate()}`
    );
  }

  return {
    calendarClosed: calendar.closed || 0,
    settled: settle.settled || 0,
    refreshed: settle.refreshed || 0,
    staleClosed: settle.staleClosed || 0,
    repaired: settle.repaired || 0,
  };
}

module.exports = {
  runLiveLifecycleOnce,
  settleActiveLiveTips,
  resolveOutcome,
  isFinishedStatus,
};
