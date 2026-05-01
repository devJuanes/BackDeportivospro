const { db } = require("../config/database");

const FIXTURE_TABLE = process.env.FACTORY_FIXTURES_TABLE || "fixtures_cache";

function toCacheRow(row) {
  return {
    source: row.source || "espn",
    source_event_id: String(row.eventId || row.source_event_id || ""),
    sport: row.sport || "football",
    league: row.league || "League",
    match_date: row.match_date,
    match_hour: row.match_hour || "00:00",
    team_a: row.homeTeam || row.team_a || "Local",
    team_b: row.awayTeam || row.team_b || "Visitante",
    status: row.status || "pre",
    minute: row.minute || 0,
    home_goals: row.homeGoals || row.home_goals || 0,
    away_goals: row.awayGoals || row.away_goals || 0,
    raw_payload: row.raw_payload || null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertFixtures(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  const payload = rows.map(toCacheRow).filter((r) => r.source_event_id && r.match_date);
  if (payload.length === 0) {
    return 0;
  }
  const { error } = await db.from(FIXTURE_TABLE).upsert(payload, {
    onConflict: "source,source_event_id",
  });
  if (error) {
    throw new Error(error.message || "No se pudieron guardar fixtures en caché");
  }
  return payload.length;
}

async function getFixturesByDateSport(matchDate, sport) {
  let query = db.from(FIXTURE_TABLE).select("*").eq("match_date", matchDate);
  if (sport) {
    query = query.eq("sport", sport);
  }
  const { data, error } = await query.order("match_hour", { ascending: true }).limit(500);
  if (error) {
    throw new Error(error.message || "No se pudieron leer fixtures en caché");
  }
  return data || [];
}

module.exports = {
  upsertFixtures,
  getFixturesByDateSport,
};
