const { db } = require("../config/database");
const {
  getActiveTrackingJobs,
  getPredictionById,
  updatePredictionLiveData,
} = require("../models/dpPredictionModel");
const {
  finalizeLivePrediction,
  updateLiveScore,
  isLiveState,
} = require("../models/liveModel");
const { runLiveLifecycleOnce } = require("./liveSettlementService");
const { evaluateFootballPickFromText } = require("../utils/pickResultEvaluator");
const { normalizeTeamToken } = require("../utils/predictionDedupe");
const logger = require("../utils/logger");

function teamMatch(a, b) {
  const na = normalizeTeamToken(a);
  const nb = normalizeTeamToken(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function findFixtureForPrediction(pred) {
  const matchDate = String(pred.match_date || "").slice(0, 10);
  if (!matchDate) return null;

  const { data, error } = await db
    .from("fixtures_cache")
    .select("*")
    .eq("match_date", matchDate)
    .eq("sport", pred.sport || "football")
    .limit(200);

  if (error || !data?.length) return null;

  return (
    data.find(
      (f) =>
        (teamMatch(f.team_a, pred.home_team) && teamMatch(f.team_b, pred.away_team)) ||
        (teamMatch(f.team_a, pred.away_team) && teamMatch(f.team_b, pred.home_team))
    ) || null
  );
}

async function findFixtureForLiveRow(row) {
  const matchDate = String(row.match_date || "").slice(0, 10);
  if (!matchDate) return null;

  const { data, error } = await db
    .from("fixtures_cache")
    .select("*")
    .eq("match_date", matchDate)
    .eq("sport", row.sport || "football")
    .limit(200);

  if (error || !data?.length) return null;

  return (
    data.find(
      (f) =>
        (teamMatch(f.team_a, row.home_team_name) && teamMatch(f.team_b, row.away_team_name)) ||
        (teamMatch(f.team_a, row.away_team_name) && teamMatch(f.team_b, row.home_team_name))
    ) || null
  );
}

async function getLiveRowById(id) {
  const { data, error } = await db.from("abetlive").select("*").eq("id", id).limit(1);
  if (error) return null;
  return Array.isArray(data) ? data[0] : data;
}

async function processLiveTrackingJob(job) {
  const row = await getLiveRowById(job.abetlive_id);
  const now = new Date();
  const interval = Number(job.check_interval_sec) || 90;
  const nextCheck = new Date(now.getTime() + interval * 1000);

  if (!row) {
    await db.from("dp_tracking_jobs").eq("id", job.id).update({
      status: "failed",
      updated_at: now.toISOString(),
    });
    return { skipped: true, reason: "live_missing" };
  }

  if (!isLiveState(row.state) || row.live_ended === true) {
    await db.from("dp_tracking_jobs").eq("id", job.id).update({
      status: "completed",
      next_check_at: null,
      last_checked_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    return { skipped: true, reason: "already_ended" };
  }

  const fixture = await findFixtureForLiveRow(row);
  if (!fixture) {
    await db.from("dp_tracking_jobs").eq("id", job.id).update({
      last_checked_at: now.toISOString(),
      next_check_at: nextCheck.toISOString(),
      updated_at: now.toISOString(),
    });
    return { skipped: true, reason: "no_fixture" };
  }

  const status = String(fixture.status || "").toLowerCase();
  const isLive = status === "live" || status === "in" || Number(fixture.minute) > 0;
  const isFinished = ["post", "final", "ft", "finished", "ended"].includes(status);
  const hg = Number(fixture.home_goals) || 0;
  const ag = Number(fixture.away_goals) || 0;

  if (isFinished) {
    const outcome =
      evaluateFootballPickFromText(
        row.prediction,
        hg,
        ag,
        row.home_team_name,
        row.away_team_name,
        { matchFinished: true }
      ) || "pending";
    await finalizeLivePrediction(row.id, {
      outcome,
      state: outcome === "pending" ? "ended" : outcome,
      minute: Number(fixture.minute) || row.minute || 90,
      home_goals: hg,
      away_goals: ag,
    });
    if (row.prediction_id) {
      try {
        await updatePredictionLiveData(row.prediction_id, {
          home_goals: hg,
          away_goals: ag,
          minute: Number(fixture.minute) || 90,
          is_live: false,
          status: outcome,
        });
      } catch {
        /* ignore */
      }
    }
    await db.from("dp_tracking_jobs").eq("id", job.id).update({
      last_checked_at: now.toISOString(),
      next_check_at: null,
      status: "completed",
      live_snapshot: { homeGoals: hg, awayGoals: ag, outcome, finished: true },
      updated_at: now.toISOString(),
    });
    return { updated: true, liveId: row.id, finished: true };
  }

  const early = evaluateFootballPickFromText(
    row.prediction,
    hg,
    ag,
    row.home_team_name,
    row.away_team_name,
    { matchFinished: false }
  );
  const nextState =
    early === "won" || early === "lost" || early === "void"
      ? early
      : isLive
        ? "live"
        : row.state;

  await updateLiveScore(row.id, {
    minute: Number(fixture.minute) || 0,
    home_goals: hg,
    away_goals: ag,
    state: nextState,
    outcome: early || row.outcome || null,
  });

  await db.from("dp_tracking_jobs").eq("id", job.id).update({
    last_checked_at: now.toISOString(),
    next_check_at: nextCheck.toISOString(),
    status: "active",
    live_snapshot: {
      homeGoals: hg,
      awayGoals: ag,
      minute: Number(fixture.minute) || 0,
      isLive,
      outcome: early || null,
      fixtureStatus: fixture.status,
      checkedAt: now.toISOString(),
    },
    updated_at: now.toISOString(),
  });

  return { updated: true, liveId: row.id, early: early || null };
}

async function processTrackingJob(job) {
  if (job.abetlive_id && !job.prediction_id) {
    return processLiveTrackingJob(job);
  }
  if (job.abetlive_id && job.prediction_id) {
    // Preferir liquidación del tip live; luego actualizar predicción vinculada.
    const liveResult = await processLiveTrackingJob(job);
    if (liveResult.finished) return liveResult;
  }

  const pred = await getPredictionById(job.prediction_id);
  if (!pred) {
    if (job.abetlive_id) {
      return processLiveTrackingJob(job);
    }
    await db.from("dp_tracking_jobs").eq("id", job.id).update({
      status: "failed",
      updated_at: new Date().toISOString(),
    });
    return { skipped: true, reason: "prediction_missing" };
  }

  const fixture = await findFixtureForPrediction(pred);
  const now = new Date();
  const interval = Number(job.check_interval_sec) || 120;
  const nextCheck = new Date(now.getTime() + interval * 1000);

  if (!fixture) {
    await db.from("dp_tracking_jobs").eq("id", job.id).update({
      last_checked_at: now.toISOString(),
      next_check_at: nextCheck.toISOString(),
      updated_at: now.toISOString(),
    });
    return { skipped: true, reason: "no_fixture" };
  }

  const status = String(fixture.status || "").toLowerCase();
  const isLive = status === "live" || status === "in" || Number(fixture.minute) > 0;
  const isFinished = ["post", "final", "ft", "finished"].includes(status);
  const hg = Number(fixture.home_goals) || 0;
  const ag = Number(fixture.away_goals) || 0;
  const early = evaluateFootballPickFromText(
    pred.prediction || pred.pick_text,
    hg,
    ag,
    pred.home_team,
    pred.away_team,
    { matchFinished: isFinished }
  );

  const livePatch = {
    home_goals: hg,
    away_goals: ag,
    minute: Number(fixture.minute) || 0,
    is_live: isLive && !early,
    status: early || (isFinished ? pred.status : isLive ? "live" : pred.status),
  };

  await updatePredictionLiveData(pred.id, livePatch);

  const snapshot = {
    homeGoals: livePatch.home_goals,
    awayGoals: livePatch.away_goals,
    minute: livePatch.minute,
    isLive,
    fixtureStatus: fixture.status,
    checkedAt: now.toISOString(),
  };

  await db.from("dp_tracking_jobs").eq("id", job.id).update({
    last_checked_at: now.toISOString(),
    next_check_at: isFinished ? null : nextCheck.toISOString(),
    status: isFinished ? "completed" : "active",
    live_snapshot: snapshot,
    updated_at: now.toISOString(),
  });

  return { updated: true, predictionId: pred.id, snapshot };
}

async function runTrackingJobsOnce() {
  // Solo limpieza por calendario + settle vía fixtures_cache (sin asumir scoreboard vacío).
  try {
    await runLiveLifecycleOnce([], { allowGoneFromBoard: false });
  } catch (error) {
    const msg = String(error.message || "");
    if (!msg.toLowerCase().includes("fetch failed")) {
      logger.warn(`[tracking] live lifecycle: ${msg}`);
    }
  }

  const jobs = await getActiveTrackingJobs(40);
  let updated = 0;
  for (const job of jobs) {
    try {
      const result = await processTrackingJob(job);
      if (result.updated) updated += 1;
    } catch (error) {
      const msg = String(error.message || "");
      if (!msg.toLowerCase().includes("fetch failed")) {
        logger.warn(`[tracking] job ${job.id}: ${msg}`);
      }
    }
  }
  if (updated > 0) {
    logger.info(`[tracking] Actualizados ${updated} tips seguidos.`);
  }
  return { processed: jobs.length, updated };
}

module.exports = { runTrackingJobsOnce, processTrackingJob };
