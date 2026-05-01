const { executeRawSql } = require("../config/database");
const logger = require("../utils/logger");

async function runFactoryMigrations() {
  const statements = [
    "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    "CREATE TABLE IF NOT EXISTS free_picks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), league TEXT NOT NULL, team_a TEXT NOT NULL, team_b TEXT NOT NULL, pick_text TEXT NOT NULL, odds NUMERIC(10,2) NOT NULL, confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100), probability INT CHECK (probability IS NULL OR probability BETWEEN 0 AND 100), analysis TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost')), moderation_status TEXT NOT NULL DEFAULT 'pending', moderation_note TEXT, match_date DATE NOT NULL, slug TEXT UNIQUE, seo_title TEXT, seo_description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "CREATE TABLE IF NOT EXISTS vip_picks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), league TEXT NOT NULL, team_a TEXT NOT NULL, team_b TEXT NOT NULL, pick_text TEXT NOT NULL, odds NUMERIC(10,2) NOT NULL, confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100), probability INT CHECK (probability IS NULL OR probability BETWEEN 0 AND 100), analysis TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost')), moderation_status TEXT NOT NULL DEFAULT 'pending', moderation_note TEXT, match_date DATE NOT NULL, slug TEXT UNIQUE, seo_title TEXT, seo_description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "CREATE TABLE IF NOT EXISTS news_articles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, excerpt TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'noticias' CHECK (category IN ('analisis','pronosticos','noticias','estrategia')), tags TEXT[] NOT NULL DEFAULT '{}', author TEXT NOT NULL DEFAULT 'Equipo MatuPicks', image_url TEXT, read_time INT NOT NULL DEFAULT 5 CHECK (read_time > 0), featured BOOLEAN NOT NULL DEFAULT FALSE, published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), seo_title TEXT, seo_description TEXT);",
    "CREATE TABLE IF NOT EXISTS fixtures_cache (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source TEXT NOT NULL DEFAULT 'espn', source_event_id TEXT NOT NULL, sport TEXT NOT NULL, league TEXT NOT NULL, match_date DATE NOT NULL, match_hour TEXT NOT NULL DEFAULT '00:00', team_a TEXT NOT NULL, team_b TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pre', minute INTEGER NOT NULL DEFAULT 0, home_goals INTEGER NOT NULL DEFAULT 0, away_goals INTEGER NOT NULL DEFAULT 0, raw_payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(source, source_event_id));",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS moderation_status TEXT DEFAULT 'pending';",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS moderation_note TEXT;",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS moderation_status TEXT DEFAULT 'pending';",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS moderation_note TEXT;",
    "CREATE INDEX IF NOT EXISTS idx_free_picks_moderation_status ON free_picks(moderation_status);",
    "CREATE INDEX IF NOT EXISTS idx_free_picks_match_date ON free_picks(match_date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_vip_picks_moderation_status ON vip_picks(moderation_status);",
    "CREATE INDEX IF NOT EXISTS idx_vip_picks_match_date ON vip_picks(match_date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_articles(published_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_news_featured ON news_articles(featured);",
    "CREATE INDEX IF NOT EXISTS idx_fixtures_cache_match_date_sport ON fixtures_cache(match_date, sport);",
    "CREATE TABLE IF NOT EXISTS source_registry (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, url TEXT UNIQUE, sport TEXT, is_active BOOLEAN DEFAULT TRUE, priority INTEGER DEFAULT 100, notes TEXT, created_at TIMESTAMP DEFAULT NOW());",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS health_score INTEGER DEFAULT 50;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS success_count INTEGER DEFAULT 0;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS fail_count INTEGER DEFAULT 0;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS last_latency_ms INTEGER;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS last_status INTEGER;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;",
    "ALTER TABLE IF EXISTS source_registry ADD COLUMN IF NOT EXISTS reliability_tier TEXT DEFAULT 'C';",
    "DELETE FROM news_articles WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY published_at DESC) AS rn FROM news_articles WHERE slug IS NOT NULL AND slug <> '') t WHERE rn > 1);",
    "DELETE FROM free_picks WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY match_date, team_a, team_b, pick_text ORDER BY created_at DESC) AS rn FROM free_picks) t WHERE rn > 1);",
    "DELETE FROM vip_picks WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY match_date, team_a, team_b, pick_text ORDER BY created_at DESC) AS rn FROM vip_picks) t WHERE rn > 1);",
    "ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS vip_expires_at TIMESTAMPTZ;",
    "CREATE TABLE IF NOT EXISTS wompi_vip_redemptions (reference TEXT PRIMARY KEY, wompi_transaction_id TEXT, user_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "CREATE INDEX IF NOT EXISTS idx_wompi_vip_redemptions_user_id ON wompi_vip_redemptions(user_id);",
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
