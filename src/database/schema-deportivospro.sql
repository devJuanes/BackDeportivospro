-- =============================================================================
-- DeportivosPro API — Esquema completo MatuDB (PostgreSQL)
--
-- Opción A (recomendada): npm run dev  o  npm run start  (migra solo al arrancar)
-- Opción B: npm run db:migrate
-- Opción C: pegar TODO este archivo en el SQL Editor de MatuDB (DB nueva/vacía)
--
-- Tablas principales API: dp_predictions, dp_prediction_follows, dp_tracking_jobs
-- Fábrica legacy: free_picks, vip_picks (+ abet/abetvip si FACTORY_AUTO_PUBLISH=true)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Pronósticos (tabla principal de la API) ───────────────────────────────

CREATE TABLE IF NOT EXISTS dp_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'premium', 'vip', 'super', 'top')),
  sport TEXT NOT NULL DEFAULT 'football',
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  prediction TEXT NOT NULL,
  odds NUMERIC(12, 4) NOT NULL DEFAULT 0,
  confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  probability INT CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  analysis TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'won', 'lost', 'live', 'void')),
  match_date DATE NOT NULL,
  match_hour TEXT NOT NULL DEFAULT '00:00',
  home_goals INT NOT NULL DEFAULT 0,
  away_goals INT NOT NULL DEFAULT 0,
  minute INT NOT NULL DEFAULT 0,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  follow_count INT NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'factory',
  slug TEXT,
  seo_title TEXT,
  seo_description TEXT,
  published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dp_predictions_tier ON dp_predictions (tier);
CREATE INDEX IF NOT EXISTS idx_dp_predictions_match_date ON dp_predictions (match_date DESC);
CREATE INDEX IF NOT EXISTS idx_dp_predictions_created_at ON dp_predictions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dp_predictions_sport ON dp_predictions (sport);
CREATE INDEX IF NOT EXISTS idx_dp_predictions_published ON dp_predictions (published);
CREATE INDEX IF NOT EXISTS idx_dp_predictions_status ON dp_predictions (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dp_predictions_slug ON dp_predictions (slug) WHERE slug IS NOT NULL;

-- ─── Seguimiento (estrella / follow) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS dp_prediction_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id UUID NOT NULL REFERENCES dp_predictions (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prediction_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_dp_follows_client ON dp_prediction_follows (client_id);
CREATE INDEX IF NOT EXISTS idx_dp_follows_prediction ON dp_prediction_follows (prediction_id);

-- ─── Jobs de seguimiento en vivo (robot) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS dp_tracking_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id UUID REFERENCES dp_predictions (id) ON DELETE CASCADE,
  abetlive_id UUID,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  check_interval_sec INT NOT NULL DEFAULT 120,
  live_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dp_tracking_status ON dp_tracking_jobs (status);
CREATE INDEX IF NOT EXISTS idx_dp_tracking_next ON dp_tracking_jobs (next_check_at);
CREATE INDEX IF NOT EXISTS idx_dp_tracking_abetlive ON dp_tracking_jobs (abetlive_id);

-- ─── Noticias ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS news_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'noticias'
    CHECK (category IN ('analisis', 'pronosticos', 'noticias', 'estrategia')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  author TEXT NOT NULL DEFAULT 'Equipo DeportivosPro',
  image_url TEXT,
  read_time INT NOT NULL DEFAULT 5 CHECK (read_time > 0),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seo_title TEXT,
  seo_description TEXT
);

CREATE TABLE IF NOT EXISTS sports_news (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '#',
  image TEXT NOT NULL DEFAULT '',
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_sports_news_created_at ON sports_news (created_at DESC);

-- ─── Live ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS abetlive (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT,
  league TEXT,
  home_team_name TEXT,
  away_team_name TEXT,
  minute INT NOT NULL DEFAULT 0 CHECK (minute >= 0 AND minute <= 130),
  prediction TEXT,
  confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  odds NUMERIC(12, 4),
  ai_rationale TEXT,
  outcome TEXT,
  state TEXT NOT NULL DEFAULT 'live',
  match_date DATE,
  live_ended BOOLEAN NOT NULL DEFAULT FALSE,
  home_goals INTEGER NOT NULL DEFAULT 0,
  away_goals INTEGER NOT NULL DEFAULT 0,
  prediction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abetlive_created_at ON abetlive (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abetlive_match_date ON abetlive (match_date DESC);

-- ─── Caché fixtures (robot) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fixtures_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'espn',
  source_event_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  league TEXT NOT NULL,
  match_date DATE NOT NULL,
  match_hour TEXT NOT NULL DEFAULT '00:00',
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pre',
  minute INT NOT NULL DEFAULT 0,
  home_goals INT NOT NULL DEFAULT 0,
  away_goals INT NOT NULL DEFAULT 0,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_fixtures_cache_match_date_sport ON fixtures_cache (match_date, sport);

-- ─── Fuentes / salud del robot ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS source_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  url TEXT UNIQUE,
  sport TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  priority INT NOT NULL DEFAULT 100,
  health_score INT NOT NULL DEFAULT 50,
  success_count INT NOT NULL DEFAULT 0,
  fail_count INT NOT NULL DEFAULT 0,
  last_latency_ms INT,
  last_status INT,
  last_checked_at TIMESTAMPTZ,
  reliability_tier TEXT NOT NULL DEFAULT 'C',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Configuración ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE,
  value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Usuarios / auth / pagos ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pf_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'Usuario',
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '__matudb_auth__',
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  vip_expires_at TIMESTAMPTZ,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified_at TIMESTAMPTZ,
  vip_trial_claimed_at TIMESTAMPTZ,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pf_users_firebase_uid ON pf_users (firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pf_users_phone ON pf_users (phone);
CREATE INDEX IF NOT EXISTS idx_pf_users_email ON pf_users (email);
CREATE INDEX IF NOT EXISTS idx_pf_users_vip_expires_at ON pf_users (vip_expires_at);

CREATE TABLE IF NOT EXISTS pf_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES pf_users (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pf_sessions_user_id ON pf_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_pf_sessions_expires_at ON pf_sessions (expires_at);

CREATE TABLE IF NOT EXISTS pf_email_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pf_email_otps_email_created ON pf_email_otps (email, created_at DESC);

CREATE TABLE IF NOT EXISTS wompi_vip_redemptions (
  reference TEXT PRIMARY KEY,
  wompi_transaction_id TEXT,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wompi_vip_redemptions_user_id ON wompi_vip_redemptions (user_id);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_interval TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_interval IN ('monthly', 'yearly', 'once')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES pf_users (id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans (id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'canceled', 'past_due')),
  external_provider TEXT,
  external_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions (status);

INSERT INTO subscription_plans (slug, name, description, price_cents, currency, billing_interval)
SELECT 'vip_standard', 'VIP Estándar', 'Acceso a zona VIP', 0, 'USD', 'monthly'
WHERE NOT EXISTS (SELECT 1 FROM subscription_plans WHERE slug = 'vip_standard');

-- ─── Legacy fábrica (compatibilidad) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS free_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  pick_text TEXT NOT NULL,
  odds NUMERIC(10, 2) NOT NULL,
  confidence INT,
  probability INT,
  analysis TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  moderation_status TEXT NOT NULL DEFAULT 'active',
  moderation_note TEXT,
  match_date DATE NOT NULL,
  match_hour TEXT NOT NULL DEFAULT '00:00',
  sport TEXT NOT NULL DEFAULT 'football',
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
  odds NUMERIC(10, 2) NOT NULL,
  confidence INT,
  probability INT,
  analysis TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  moderation_status TEXT NOT NULL DEFAULT 'active',
  moderation_note TEXT,
  match_date DATE NOT NULL,
  match_hour TEXT NOT NULL DEFAULT '00:00',
  sport TEXT NOT NULL DEFAULT 'football',
  slug TEXT UNIQUE,
  seo_title TEXT,
  seo_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_free_picks_match_date ON free_picks (match_date DESC);
CREATE INDEX IF NOT EXISTS idx_vip_picks_match_date ON vip_picks (match_date DESC);
CREATE INDEX IF NOT EXISTS idx_free_picks_moderation_status ON free_picks (moderation_status);
CREATE INDEX IF NOT EXISTS idx_vip_picks_moderation_status ON vip_picks (moderation_status);

-- ─── Planta pública Vue (opcional; FACTORY_AUTO_PUBLISH=true) ────────────────

CREATE TABLE IF NOT EXISTS abet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT,
  league TEXT,
  home_team_name TEXT NOT NULL DEFAULT 'Local',
  home_team_logo TEXT NOT NULL DEFAULT '',
  away_team_name TEXT NOT NULL DEFAULT 'Visitante',
  away_team_logo TEXT NOT NULL DEFAULT '',
  prediction TEXT NOT NULL DEFAULT '',
  confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  odds NUMERIC(12, 4) NOT NULL DEFAULT 0,
  match_date DATE,
  match_hour TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS abetvip (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT,
  league TEXT,
  home_team_name TEXT NOT NULL DEFAULT 'Local',
  home_team_logo TEXT NOT NULL DEFAULT '',
  away_team_name TEXT NOT NULL DEFAULT 'Visitante',
  away_team_logo TEXT NOT NULL DEFAULT '',
  prediction TEXT NOT NULL DEFAULT '',
  confidence INT CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  odds NUMERIC(12, 4) NOT NULL DEFAULT 0,
  match_date DATE,
  match_hour TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abet_created_at ON abet (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abet_match_date ON abet (match_date DESC);
CREATE INDEX IF NOT EXISTS idx_abetvip_created_at ON abetvip (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abetvip_match_date ON abetvip (match_date DESC);

-- ─── Notificaciones push ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL DEFAULT 'deportivospro',
  token TEXT NOT NULL,
  device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, app_id, token)
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL DEFAULT 'deportivospro',
  recipient_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_tokens_user ON notification_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_recipient ON notification_logs (recipient_id, created_at DESC);

-- ─── Blog extras en news_articles ──────────────────────────────────────────

ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS matupicks_pick_id UUID;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS matupicks_pick_tier TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS matupicks_blog_kind TEXT;
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS matupicks_youtube_url TEXT;
CREATE INDEX IF NOT EXISTS idx_news_matupicks_pick_kind ON news_articles (matupicks_pick_id, matupicks_blog_kind);
CREATE INDEX IF NOT EXISTS idx_news_featured ON news_articles (featured);
CREATE INDEX IF NOT EXISTS idx_abetlive_sport ON abetlive (sport);
CREATE INDEX IF NOT EXISTS idx_abetlive_state ON abetlive (state);

-- ─── Migración de datos legacy (free_picks / vip_picks → dp_predictions) ───

INSERT INTO dp_predictions (
  tier, sport, league, home_team, away_team, prediction, odds, confidence,
  probability, analysis, status, match_date, match_hour, slug, seo_title,
  seo_description, published, created_at, updated_at
)
SELECT
  'free', COALESCE(sport, 'football'), league, team_a, team_b, pick_text, odds,
  confidence, probability, analysis, status, match_date,
  COALESCE(match_hour, '00:00'), slug, seo_title, seo_description, TRUE,
  created_at, updated_at
FROM free_picks fp
WHERE NOT EXISTS (
  SELECT 1 FROM dp_predictions d
  WHERE d.home_team = fp.team_a AND d.away_team = fp.team_b
    AND d.match_date = fp.match_date AND d.prediction = fp.pick_text AND d.tier = 'free'
);

INSERT INTO dp_predictions (
  tier, sport, league, home_team, away_team, prediction, odds, confidence,
  probability, analysis, status, match_date, match_hour, slug, seo_title,
  seo_description, published, created_at, updated_at
)
SELECT
  'vip', COALESCE(sport, 'football'), league, team_a, team_b, pick_text, odds,
  confidence, probability, analysis, status, match_date,
  COALESCE(match_hour, '00:00'), slug, seo_title, seo_description, TRUE,
  created_at, updated_at
FROM vip_picks vp
WHERE NOT EXISTS (
  SELECT 1 FROM dp_predictions d
  WHERE d.home_team = vp.team_a AND d.away_team = vp.team_b
    AND d.match_date = vp.match_date AND d.prediction = vp.pick_text AND d.tier = 'vip'
);
