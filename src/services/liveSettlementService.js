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
  finalizeLivePrediction,
  updateLiveScore,
  finalizeStaleLiveByCalendar,
  todayLiveDate,
  rowMatchDate,
} = require("../models/liveModel");
const { getFixturesByDateSport } = require("../models/fixtureModel");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
const { normalizeTeamToken } = require("../utils/predictionDedupe");
const { updatePredictionLiveData, updatePredictionState } = require("../models/dpPredictionModel");

const FINISHED_STATUSES = new Set(["post", "final", "ft", "finished", "ended", "complete", "completed"]);

function teamMatch(a, b) {
  const na = normalizeTeamToken(a);
  const nb = normalizeTeamToken(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function isFinishedStatus(status) {
  return FINISHED_STATUSES.has(String(status || "").toLowerCase());
}

function findLiveMatch(activeMatches, home, away) {
  return (
    (activeMatches || []).find(
      (m) =>
        (teamMatch(m.homeTeam, home) && teamMatch(m.awayTeam, away)) ||
        (teamMatch(m.homeTeam, away) && teamMatch(m.awayTeam, home))
    ) || null
  );
}

async function findCachedFixture(sport, matchDate, home, away) {
  if (!matchDate) return null;
  try {
    const rows = await getFixturesByDateSport(matchDate, sport || "football");
    return (
      (rows || []).find(
        (f) =>
          (teamMatch(f.team_a, home) && teamMatch(f.team_b, away)) ||
          (teamMatch(f.team_a, away) && teamMatch(f.team_b, home))
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
  try {
    await updatePredictionLiveData(predId, {
      home_goals: homeGoals,
      away_goals: awayGoals,
      minute: minute || 0,
      is_live: Boolean(isLive) && !finished,
      status: finished ? outcome || "pending" : isLive ? "live" : undefined,
    });
    if (finished && (outcome === "won" || outcome === "lost" || outcome === "pending")) {
      await updatePredictionState(predId, outcome);
      await updatePredictionLiveData(predId, { is_live: false, status: outcome });
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
function resolveOutcome(row, homeGoals, awayGoals) {
  const sport = String(row.sport || "football").toLowerCase();
  if (sport !== "football" && sport !== "soccer") {
    return "pending";
  }
  const evaluated = evaluateFootballPickFromText(
    row.prediction,
    homeGoals,
    awayGoals,
    row.home_team_name,
    row.away_team_name
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
    return { settled: 0, refreshed: 0, staleClosed: 0 };
  }

  let settled = 0;
  let refreshed = 0;
  let staleClosed = 0;

  for (const row of rows) {
    const home = row.home_team_name;
    const away = row.away_team_name;
    const matchDate = rowMatchDate(row) || today;
    const pairKey = `${home}|${away}`;

    // Día anterior (o sin fecha clara pero created_at viejo): fuera del feed live.
    if (matchDate < today) {
      await finalizeLivePrediction(row.id, { outcome: "pending", state: "ended" });
      await completeTrackingJobsForLive(row.id);
      staleClosed += 1;
      continue;
    }

    const liveHit = findLiveMatch(activeLiveMatches, home, away);
    if (liveHit) {
      try {
        await updateLiveScore(row.id, {
          minute: liveHit.minute,
          home_goals: liveHit.homeGoals,
          away_goals: liveHit.awayGoals,
          state: "live",
        }, { ai_rationale: row.ai_rationale });
        await syncLinkedPrediction(row, {
          finished: false,
          homeGoals: liveHit.homeGoals,
          awayGoals: liveHit.awayGoals,
          minute: liveHit.minute,
          isLive: true,
        });
        refreshed += 1;
      } catch (error) {
        logger.warn(`[live-settle] refresh ${row.id}: ${error.message}`);
      }
      continue;
    }

    // No está en el scoreboard en vivo: mirar caché / estado final.
    const fixture = await findCachedFixture(row.sport, matchDate, home, away);
    const fxStatus = String(fixture?.status || "").toLowerCase();
    const finished = fixture && isFinishedStatus(fxStatus);

    if (finished) {
      const hg = Number(fixture.home_goals) || 0;
      const ag = Number(fixture.away_goals) || 0;
      const outcome = resolveOutcome(row, hg, ag);
      await finalizeLivePrediction(row.id, {
        outcome,
        state: "ended",
        minute: Number(fixture.minute) || row.minute || 90,
        home_goals: hg,
        away_goals: ag,
      });
      await syncLinkedPrediction(row, {
        finished: true,
        outcome,
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
      const outcome =
        fixture && isFinishedStatus(fxStatus) ? resolveOutcome(row, hg, ag) : "pending";
      await finalizeLivePrediction(row.id, {
        outcome,
        state: "ended",
        home_goals: hg,
        away_goals: ag,
      });
      await syncLinkedPrediction(row, {
        finished: true,
        outcome,
        homeGoals: hg,
        awayGoals: ag,
        minute: row.minute,
        isLive: false,
      });
      await completeTrackingJobsForLive(row.id);
      settled += 1;
    }
  }

  return { settled, refreshed, staleClosed, today };
}

/**
 * Pasada completa: limpieza por calendario + settle de activos.
 * @param {Array} activeLiveMatches
 * @param {{ allowGoneFromBoard?: boolean }} options
 */
async function runLiveLifecycleOnce(activeLiveMatches = [], options = {}) {
  let calendar = { closed: 0 };
  try {
    calendar = await finalizeStaleLiveByCalendar(300);
  } catch (error) {
    logger.warn(`[live-settle] cleanup calendario: ${error.message}`);
  }

  let settle = { settled: 0, refreshed: 0, staleClosed: 0 };
  try {
    settle = await settleActiveLiveTips(activeLiveMatches, options);
  } catch (error) {
    logger.warn(`[live-settle] ciclo: ${error.message}`);
  }

  const closed = (calendar.closed || 0) + (settle.staleClosed || 0) + (settle.settled || 0);
  if (closed > 0 || settle.refreshed > 0) {
    logger.info(
      `[live-settle] cerrados=${closed}, actualizados=${settle.refreshed || 0}, dia=${calendar.today || settle.today || todayLiveDate()}`
    );
  }

  return {
    calendarClosed: calendar.closed || 0,
    settled: settle.settled || 0,
    refreshed: settle.refreshed || 0,
    staleClosed: settle.staleClosed || 0,
  };
}

module.exports = {
  runLiveLifecycleOnce,
  settleActiveLiveTips,
  resolveOutcome,
  isFinishedStatus,
};
