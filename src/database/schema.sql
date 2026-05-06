CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS free_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  pick_text TEXT NOT NULL,
  odds NUMERIC(10,2) NOT NULL,
  confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  probability INT CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  analysis TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost')),
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  moderation_note TEXT,
  match_date DATE NOT NULL,
  slug TEXT UNIQUE,
  seo_title TEXT,
  seo_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vip_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  pick_text TEXT NOT NULL,
  odds NUMERIC(10,2) NOT NULL,
  confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  probability INT CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  analysis TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost')),
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  moderation_note TEXT,
  match_date DATE NOT NULL,
  slug TEXT UNIQUE,
  seo_title TEXT,
  seo_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE free_picks
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE free_picks
  ADD COLUMN IF NOT EXISTS moderation_note TEXT;

ALTER TABLE vip_picks
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE vip_picks
  ADD COLUMN IF NOT EXISTS moderation_note TEXT;

CREATE TABLE IF NOT EXISTS abetlive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT,
  league TEXT,
  home_team_name TEXT,
  away_team_name TEXT,
  minute INTEGER,
  prediction TEXT,
  confidence INTEGER,
  odds NUMERIC,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'noticias' CHECK (category IN ('analisis', 'pronosticos', 'noticias', 'estrategia')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  author TEXT NOT NULL DEFAULT 'Equipo MatuPicks',
  image_url TEXT,
  read_time INT NOT NULL DEFAULT 5 CHECK (read_time > 0),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seo_title TEXT,
  seo_description TEXT
);

CREATE TABLE IF NOT EXISTS system_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE,
  value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  url TEXT UNIQUE,
  sport TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  priority INTEGER DEFAULT 100,
  health_score INTEGER DEFAULT 50,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_latency_ms INTEGER,
  last_status INTEGER,
  last_checked_at TIMESTAMP,
  reliability_tier TEXT DEFAULT 'C',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_free_picks_moderation_status ON free_picks(moderation_status);
CREATE INDEX IF NOT EXISTS idx_free_picks_match_date ON free_picks(match_date DESC);
CREATE INDEX IF NOT EXISTS idx_vip_picks_moderation_status ON vip_picks(moderation_status);
CREATE INDEX IF NOT EXISTS idx_vip_picks_match_date ON vip_picks(match_date DESC);
CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_articles(published_at DESC);

CREATE TABLE IF NOT EXISTS notification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT 'matupicks',
  token TEXT NOT NULL,
  device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, app_id, token)
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL DEFAULT 'matupicks',
  recipient_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_tokens_user ON notification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_recipient ON notification_logs(recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ladder_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  capital_initial NUMERIC(14,2) NOT NULL,
  capital_current NUMERIC(14,2) NOT NULL,
  daily_target NUMERIC(14,2) NOT NULL,
  multiplier_mode TEXT NOT NULL DEFAULT 'auto' CHECK (multiplier_mode IN ('auto','flat','custom')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','target_reached','closed','busted')),
  steps_won INT NOT NULL DEFAULT 0,
  steps_lost INT NOT NULL DEFAULT 0,
  steps_total INT NOT NULL DEFAULT 0,
  notes TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ladder_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ladder_sessions(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','won','lost','skipped')),
  prediction_source TEXT NOT NULL DEFAULT 'ai',
  prediction_ref_id UUID,
  prediction_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_stake NUMERIC(14,2) NOT NULL DEFAULT 0,
  recommended_odds NUMERIC(10,4) NOT NULL DEFAULT 0,
  stake_actual NUMERIC(14,2),
  executed_odds NUMERIC(10,4),
  profit_loss NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance_after NUMERIC(14,2),
  rationale TEXT,
  confidence INT,
  decided_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ladder_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ladder_sessions(id) ON DELETE CASCADE,
  step_id UUID REFERENCES ladder_steps(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ladder_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id UUID REFERENCES ladder_steps(id) ON DELETE SET NULL,
  session_id UUID NOT NULL REFERENCES ladder_sessions(id) ON DELETE CASCADE,
  model TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ladder_sessions_user_status ON ladder_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ladder_steps_session_status ON ladder_steps(session_id, status);
CREATE INDEX IF NOT EXISTS idx_ladder_events_session ON ladder_events(session_id, created_at DESC);
