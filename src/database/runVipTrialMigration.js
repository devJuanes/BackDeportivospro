/**
 * Aplica columnas VIP / trial / phone / OTP y verifica el SELECT que usa el front.
 * Uso: node src/database/runVipTrialMigration.js
 */
require("dotenv").config();
const { createClient } = require("@devjuanes/matuclient");

const matuUrl = process.env.MATUDB_URL;
const projectId = process.env.MATUDB_PROJECT_ID;
const apiKey = process.env.MATUDB_API_KEY;

if (!matuUrl || !projectId || !apiKey) {
  console.error("Faltan MATUDB_URL / MATUDB_PROJECT_ID / MATUDB_API_KEY en .env");
  process.exit(1);
}

const db = createClient({
  url: matuUrl,
  projectId,
  apiKey,
  useSupabase: process.env.MATUDB_USE_SUPABASE === "true",
});

async function runSql(sql) {
  const { data, error } = await db.rpc(sql);
  if (error) throw new Error(error.message || JSON.stringify(error));
  return data;
}

const statements = [
  "ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS vip_expires_at TIMESTAMPTZ",
  "ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ",
  "ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS vip_trial_claimed_at TIMESTAMPTZ",
  "ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS phone TEXT",
  `CREATE TABLE IF NOT EXISTS pf_email_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE INDEX IF NOT EXISTS idx_pf_users_phone ON pf_users(phone)",
  "CREATE INDEX IF NOT EXISTS idx_pf_users_vip_expires_at ON pf_users(vip_expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_pf_email_otps_email_created ON pf_email_otps(email, created_at DESC)",
];

async function main() {
  console.log("MatuDB URL:", String(matuUrl).replace(/\/\/.*@/, "//***@"));
  console.log("Project:", String(projectId).slice(0, 8) + "…");

  // Ping
  try {
    const ping = await fetch(String(matuUrl).replace(/\/$/, "") + "/health");
    console.log("Health:", ping.status);
  } catch (e) {
    console.error("Health fetch failed:", e.cause?.code || e.message);
  }

  for (const sql of statements) {
    try {
      await runSql(sql);
      console.log("OK:", sql.slice(0, 72).replace(/\s+/g, " "));
    } catch (e) {
      console.error("FAIL:", e.message);
    }
  }

  try {
    const { data, error } = await db
      .from("pf_users")
      .select("name,is_vip,is_admin,vip_expires_at")
      .limit(1);
    if (error) throw new Error(error.message);
    console.log("VERIFY REST select OK — rows:", (data || []).length);
  } catch (e) {
    console.error("VERIFY FAILED:", e.message);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message, e.cause || "");
  process.exit(1);
});
