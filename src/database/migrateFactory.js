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
    "CREATE TABLE IF NOT EXISTS pf_users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL DEFAULT 'Usuario', email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT '__matudb_auth__', is_vip BOOLEAN NOT NULL DEFAULT FALSE, vip_expires_at TIMESTAMPTZ, is_admin BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE, email_verified_at TIMESTAMPTZ, vip_trial_claimed_at TIMESTAMPTZ, phone TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "ALTER TABLE IF EXISTS pf_users ADD COLUMN IF NOT EXISTS vip_expires_at TIMESTAMPTZ;",
    "ALTER TABLE IF EXISTS pf_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE IF EXISTS pf_users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;",
    "ALTER TABLE IF EXISTS pf_users ADD COLUMN IF NOT EXISTS vip_trial_claimed_at TIMESTAMPTZ;",
    "ALTER TABLE IF EXISTS pf_users ADD COLUMN IF NOT EXISTS phone TEXT;",
    "CREATE INDEX IF NOT EXISTS idx_pf_users_phone ON pf_users(phone);",
    "CREATE TABLE IF NOT EXISTS pf_email_otps (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, attempts INT NOT NULL DEFAULT 0, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "CREATE INDEX IF NOT EXISTS idx_pf_email_otps_email_created ON pf_email_otps(email, created_at DESC);",
    "CREATE TABLE IF NOT EXISTS wompi_vip_redemptions (reference TEXT PRIMARY KEY, wompi_transaction_id TEXT, user_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "CREATE INDEX IF NOT EXISTS idx_wompi_vip_redemptions_user_id ON wompi_vip_redemptions(user_id);",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS match_hour TEXT NOT NULL DEFAULT '00:00';",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS match_hour TEXT NOT NULL DEFAULT '00:00';",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'football';",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'football';",
    "ALTER TABLE IF EXISTS news_articles ADD COLUMN IF NOT EXISTS matupicks_pick_id UUID;",
    "ALTER TABLE IF EXISTS news_articles ADD COLUMN IF NOT EXISTS matupicks_pick_tier TEXT;",
    "ALTER TABLE IF EXISTS news_articles ADD COLUMN IF NOT EXISTS matupicks_blog_kind TEXT;",
    "ALTER TABLE IF EXISTS news_articles ADD COLUMN IF NOT EXISTS matupicks_youtube_url TEXT;",
    "CREATE INDEX IF NOT EXISTS idx_news_matupicks_pick_kind ON news_articles(matupicks_pick_id, matupicks_blog_kind);",
    "CREATE TABLE IF NOT EXISTS sports_news (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT, summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', slug TEXT, url TEXT NOT NULL DEFAULT '#', external_source_url TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', source TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    "ALTER TABLE IF EXISTS sports_news ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS sports_news ADD COLUMN IF NOT EXISTS slug TEXT;",
    "ALTER TABLE IF EXISTS sports_news ADD COLUMN IF NOT EXISTS external_source_url TEXT NOT NULL DEFAULT '';",
    "CREATE INDEX IF NOT EXISTS idx_sports_news_slug ON sports_news(slug);",
    "CREATE INDEX IF NOT EXISTS idx_sports_news_created_at ON sports_news(created_at DESC);",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'live';",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS ai_rationale TEXT;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS outcome TEXT;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS match_date DATE;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS live_ended BOOLEAN NOT NULL DEFAULT FALSE;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS home_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS away_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS prediction_id UUID;",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS home_team_logo TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS abetlive ADD COLUMN IF NOT EXISTS away_team_logo TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS home_team_logo TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS away_team_logo TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS home_team_logo TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS away_team_logo TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS home_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS away_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abet ADD COLUMN IF NOT EXISTS minute INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS home_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS away_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS abetvip ADD COLUMN IF NOT EXISTS minute INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS home_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS away_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS free_picks ADD COLUMN IF NOT EXISTS minute INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS home_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS away_goals INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE IF EXISTS vip_picks ADD COLUMN IF NOT EXISTS minute INTEGER NOT NULL DEFAULT 0;",
    `CREATE TABLE IF NOT EXISTS factory_run_lock (
      lock_key TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_abetlive_match_date ON abetlive(match_date DESC);",
    "CREATE INDEX IF NOT EXISTS idx_abetlive_state_date ON abetlive(state, match_date);",
    "ALTER TABLE IF EXISTS dp_tracking_jobs ADD COLUMN IF NOT EXISTS abetlive_id UUID;",
    "ALTER TABLE IF EXISTS dp_tracking_jobs ALTER COLUMN prediction_id DROP NOT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_dp_tracking_abetlive ON dp_tracking_jobs(abetlive_id);",
    // Trip / Escalera (MatuPicks)
    `CREATE TABLE IF NOT EXISTS ladder_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      capital_initial NUMERIC(12,2) NOT NULL DEFAULT 100,
      capital_current NUMERIC(12,2) NOT NULL DEFAULT 100,
      daily_target NUMERIC(12,2) NOT NULL DEFAULT 20,
      multiplier_mode TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      steps_won INT NOT NULL DEFAULT 0,
      steps_lost INT NOT NULL DEFAULT 0,
      steps_total INT NOT NULL DEFAULT 0,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    "CREATE INDEX IF NOT EXISTS idx_ladder_sessions_user_status ON ladder_sessions(user_id, status);",
    "CREATE INDEX IF NOT EXISTS idx_ladder_sessions_opened_at ON ladder_sessions(opened_at DESC);",
    `CREATE TABLE IF NOT EXISTS ladder_steps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL,
      step_index INT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      prediction_source TEXT,
      prediction_ref_id TEXT,
      prediction_payload JSONB,
      recommended_stake NUMERIC(12,2),
      recommended_odds NUMERIC(10,2),
      stake_actual NUMERIC(12,2),
      executed_odds NUMERIC(10,2),
      rationale TEXT,
      confidence NUMERIC(5,2),
      profit_loss NUMERIC(12,2),
      balance_after NUMERIC(12,2),
      decided_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    "CREATE INDEX IF NOT EXISTS idx_ladder_steps_session ON ladder_steps(session_id, step_index DESC);",
    "CREATE INDEX IF NOT EXISTS idx_ladder_steps_status ON ladder_steps(session_id, status);",
    `CREATE TABLE IF NOT EXISTS ladder_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID,
      step_id UUID,
      event_type TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS ladder_recommendations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      step_id UUID,
      session_id UUID,
      model TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    // Engagement MatuPicks (likes / follows / comments / prefs)
    `CREATE TABLE IF NOT EXISTS pf_prediction_likes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      prediction_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, prediction_id)
    );`,
    `CREATE TABLE IF NOT EXISTS pf_prediction_follows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      prediction_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, prediction_id)
    );`,
    `CREATE TABLE IF NOT EXISTS pf_prediction_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      prediction_id TEXT NOT NULL,
      user_name TEXT NOT NULL DEFAULT 'Usuario',
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    "CREATE INDEX IF NOT EXISTS idx_pf_comments_prediction ON pf_prediction_comments(prediction_id, created_at DESC);",
    `CREATE TABLE IF NOT EXISTS pf_notification_prefs (
      user_id UUID PRIMARY KEY,
      notif_live BOOLEAN NOT NULL DEFAULT TRUE,
      notif_free BOOLEAN NOT NULL DEFAULT TRUE,
      notif_vip BOOLEAN NOT NULL DEFAULT TRUE,
      notif_news BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS app_banners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL DEFAULT '',
      subtitle TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL DEFAULT 'none',
      action_value TEXT NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
  ];

  for (const sql of statements) {
    try {
      await executeRawSql(sql);
    } catch (error) {
      const msg = String(error.message || "");
      const skip =
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("does not exist");
      if (!skip) {
        logger.warn(`Migración no aplicada (${sql.slice(0, 80)}…): ${msg}`);
      }
    }
  }
}

module.exports = {
  runFactoryMigrations,
};
