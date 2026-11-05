const { db } = require("../config/database");
const logger = require("../utils/logger");

const SIM_NAMES = [
  "AndresCali",
  "ProTipsterCO",
  "ValentinaR",
  "MateoStats",
  "LuchoPicks",
  "CamilaVIP",
  "DiegoAnaliza",
  "SofiaGoles",
  "KevinOver",
  "NataliaLive",
  "JuanBetPlay",
  "CaroHandicap",
  "FelipeBTTS",
  "ManuCorners",
  "IsaPremier",
  "TomiNBA",
  "RafaTenis",
  "LinaHockey",
  "BrunoMMA",
  "PauSerieA",
];

const REPLY_TEMPLATES = [
  (p) => `Yo también voy con ${p.prediction}. Confianza alta.`,
  (p) => `Cuidado con el ritmo de ${p.away}; igual me gusta el pick.`,
  (p) => `¿Alguien vio la forma reciente de ${p.home}?`,
  () => "Buen análisis, gracias por compartir.",
  (p) => `Este mercado de ${p.league} suele ser volátil, ojo.`,
  () => "Yo lo tengo guardado en VIP, ojalá cierre verde.",
  (p) => `${p.home} viene fuerte de local, tiene sentido.`,
  () => "¿Cuál es el minuto ideal para entrar si es live?",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function simUser() {
  const name = pick(SIM_NAMES);
  return {
    user_name: name,
    user_id: `sim_${name.toLowerCase()}`,
  };
}

async function fetchRecentPicks(limit = 16) {
  const tables = [
    { table: "abet", tier: "free" },
    { table: "abetvip", tier: "vip" },
    { table: "abetlive", tier: "live" },
  ];
  const rows = [];
  for (const { table, tier } of tables) {
    try {
      const { data, error } = await db
        .from(table)
        .select(
          "id,home_team_name,away_team_name,league,sport,prediction,match_date,created_at",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        logger.warn(`[community] select ${table}: ${error.message}`);
        continue;
      }
      for (const r of data || []) {
        const prediction = String(r.prediction || "Pronóstico").trim();
        rows.push({
          id: String(r.id),
          tier,
          home: String(r.home_team_name || "Local"),
          away: String(r.away_team_name || "Visitante"),
          league: String(r.league || "General"),
          sport: String(r.sport || "football"),
          prediction,
          analysis: "",
        });
      }
    } catch (e) {
      logger.warn(`[community] no se pudo leer ${table}: ${e.message}`);
    }
  }
  // únicos por id
  const seen = new Set();
  return rows.filter((r) => {
    if (!r.id || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

async function ensureMemberCount() {
  const MIN = 7000;
  const { data } = await db
    .from("pf_community_meta")
    .select("key,value")
    .eq("key", "member_count")
    .limit(1);
  const current = Number.parseInt(String(data?.[0]?.value || "0"), 10) || 0;
  if (current >= MIN) return current;
  const value = String(randInt(7240, 8960));
  if (data?.[0]) {
    await db
      .from("pf_community_meta")
      .eq("key", "member_count")
      .update({ value, updated_at: new Date().toISOString() });
  } else {
    await db.from("pf_community_meta").insert({
      key: "member_count",
      value,
      updated_at: new Date().toISOString(),
    });
  }
  return Number(value);
}

async function threadExistsForPrediction(predictionId) {
  const { data } = await db
    .from("pf_community_threads")
    .select("id")
    .eq("prediction_id", predictionId)
    .limit(1);
  return Boolean(data?.[0]?.id);
}

async function createThreadFromPick(row) {
  const author = simUser();
  const title = `${row.home} vs ${row.away}: ${row.prediction}`;
  const body =
    row.analysis ||
    `Hilo abierto sobre ${row.home} vs ${row.away} (${row.league}). Pick: ${row.prediction}. ¿Qué opinan?`;
  const { error } = await db.from("pf_community_threads").insert({
    title: title.slice(0, 160),
    body: body.slice(0, 1200),
    user_name: author.user_name,
    user_id: author.user_id,
    prediction_id: row.id,
    sport: row.sport,
    league: row.league,
    home_team: row.home,
    away_team: row.away,
    upvotes: randInt(3, 86),
    reply_count: 0,
    is_simulated: true,
  });
  if (error) throw new Error(error.message || "insert thread failed");
  const { data: created } = await db
    .from("pf_community_threads")
    .select("id")
    .eq("prediction_id", row.id)
    .limit(1);
  const threadId = created?.[0]?.id;
  if (!threadId) return null;

  const replyN = randInt(2, 5);
  const replies = [];
  for (let i = 0; i < replyN; i += 1) {
    const u = simUser();
    replies.push({
      thread_id: threadId,
      user_name: u.user_name,
      user_id: u.user_id,
      body: pick(REPLY_TEMPLATES)(row).slice(0, 400),
      is_simulated: true,
    });
  }
  if (replies.length) {
    await db.from("pf_community_replies").insert(replies);
    await db
      .from("pf_community_threads")
      .eq("id", threadId)
      .update({ reply_count: replies.length });
  }
  return threadId;
}

/**
 * Crea hilos (estilo Reddit) a partir de pronósticos reales y deja
 * member_count >= 7000 para mostrar comunidad activa.
 */
async function ensureCommunitySeed({ maxNew = 12 } = {}) {
  const members = await ensureMemberCount();
  const picks = await fetchRecentPicks(14);
  let created = 0;
  for (const pickRow of picks) {
    if (created >= maxNew) break;
    try {
      if (await threadExistsForPrediction(pickRow.id)) continue;
      const id = await createThreadFromPick(pickRow);
      if (id) created += 1;
    } catch (e) {
      logger.warn(`[community] hilo omitido (${pickRow.id}): ${e.message}`);
    }
  }
  logger.info(
    `[community] seed OK members=${members} created_threads=${created} picks_scanned=${picks.length}`,
  );
  return { members, created, scanned: picks.length };
}

module.exports = {
  ensureCommunitySeed,
  ensureMemberCount,
};
