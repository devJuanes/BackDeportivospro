const { executeRawSql } = require("../config/database");
const logger = require("../utils/logger");

async function runFactoryMigrations() {
  const statements = [
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS rationale_short TEXT;",
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS source TEXT;",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS rationale_short TEXT;",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS source TEXT;",
    "CREATE TABLE IF NOT EXISTS source_registry (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, url TEXT UNIQUE, sport TEXT, is_active BOOLEAN DEFAULT TRUE, priority INTEGER DEFAULT 100, notes TEXT, created_at TIMESTAMP DEFAULT NOW());",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS health_score INTEGER DEFAULT 50;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS success_count INTEGER DEFAULT 0;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS fail_count INTEGER DEFAULT 0;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS last_latency_ms INTEGER;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS last_status INTEGER;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS reliability_tier TEXT DEFAULT 'C';",
    "DELETE FROM sports_news WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY url ORDER BY created_at DESC) AS rn FROM sports_news WHERE url IS NOT NULL AND url <> '') t WHERE rn > 1);",
    "DELETE FROM abet WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY sport, match_date, home_team_name, away_team_name, prediction ORDER BY created_at DESC) AS rn FROM abet) t WHERE rn > 1);",
    "DELETE FROM abetvip WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY sport, match_date, home_team_name, away_team_name, prediction ORDER BY created_at DESC) AS rn FROM abetvip) t WHERE rn > 1);",
  ];

  for (const sql of statements) {
    try {
      await executeRawSql(sql);
    } catch (error) {
      logger.warn(`Migración no aplicada (${sql}): ${error.message}`);
    }
  }
}

module.exports = {
  runFactoryMigrations,
};
