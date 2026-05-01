-- =============================================================================
-- ESQUEMA UNIFICADO MatuDB — Prediction Factory (Vue) + BackDeportivospro (Node)
--
-- Copia de prediction-factory/database/schema-unified-matudb.sql — mantener sincronizado.
--
-- Usa UN SOLO proyecto MatuDB: mismos MATUDB_PROJECT_ID / API key en:
--   prediction-factory/.env → VITE_MATUDB_*
--   BackDeportivospro/.env    → MATUDB_*
--
-- IMPORTANTE — picks duplicados (nombre de tabla):
--   • BackDeportivospro escribe en: free_picks, vip_picks (modelos actuales).
--   • prediction-factory lee por defecto: abet, abetvip (api.ts).
-- Para ver en la app Vue los picks que genera la fábrica sin duplicar datos:
--   cambia en prediction-factory/src/services/api.ts las tablas a free_picks /
--   vip_picks y mapea columnas (team_a→homeTeam, pick_text→prediction, etc.)
--   O bien configura la fábrica para escribir también en abet (no recomendado).
--
-- Este script crea TODO lo necesario para que backend + auth + noticias + live
-- + caché de fixtures funcionen tal como están los repos hoy.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────────────────────────────────────────────────────────
-- BACKEND — pronósticos moderados (fábrica)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS free_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  pick_text TEXT NOT NULL,
  odds NUMERIC(10, 2) NOT NULL,
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
  odds NUMERIC(10, 2) NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_free_picks_moderation_status ON free_picks (moderation_status);
CREATE INDEX IF NOT EXISTS idx_free_picks_match_date ON free_picks (match_date DESC);
CREATE INDEX IF NOT EXISTS idx_free_picks_created_at ON free_picks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vip_picks_moderation_status ON vip_picks (moderation_status);
CREATE INDEX IF NOT EXISTS idx_vip_picks_match_date ON vip_picks (match_date DESC);
CREATE INDEX IF NOT EXISTS idx_vip_picks_created_at ON vip_picks (created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- BACKEND — noticias (newsModel.js → FACTORY_NEWS_TABLE por defecto news_articles)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS news_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'noticias'
    CHECK (category IN ('analisis', 'pronosticos', 'noticias', 'estrategia')),
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

CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_featured ON news_articles (featured);

-- ───────────────────────────────────────────────────────────────────────────
-- BACKEND — señales live (liveModel.js → abetlive)
-- ───────────────────────────────────────────────────────────────────────────

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- BD existentes: añadir columnas nuevas sin recrear la tabla
ALTER TABLE abetlive ADD COLUMN IF NOT EXISTS ai_rationale TEXT;
ALTER TABLE abetlive ADD COLUMN IF NOT EXISTS outcome TEXT;

CREATE INDEX IF NOT EXISTS idx_abetlive_created_at ON abetlive (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abetlive_sport ON abetlive (sport);
CREATE INDEX IF NOT EXISTS idx_abetlive_state ON abetlive (state);

-- ───────────────────────────────────────────────────────────────────────────
-- BACKEND — caché de fixtures (fixtureModel.js → fixtures_cache)
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- BACKEND — registro de fuentes / salud (sourceService)
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- FRONTEND Vue — pronósticos legacy (api.ts → abet / abetvip, filtro por created_at)
-- ───────────────────────────────────────────────────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_abetvip_created_at ON abetvip (created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- FRONTEND Vue — noticias simplificadas (api.ts → sports_news)
-- Nota: el backend usa news_articles; son dos modelos distintos.
-- ───────────────────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_sports_news_created_at ON sports_news (created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- ESQUEMA DE LA APLICACIÓN — usuarios en tu modelo SQL (consultas / joins / BI)
-- Tabla: pf_users (+ opcional pf_sessions legacy).
--
-- MatuDB Auth del proyecto usa otra tabla interna: _matudb_users (guión bajo;
-- la crea la API, bcrypt, JWT). El panel “Gestión de Usuarios” lista esa.
-- La app debe mantener pf_users alineada: mismo id UUID que devuelve Auth;
-- password_hash puede ser marcador __matudb_auth__ (clave real en _matudb_users).
-- is_admin: staff (role 'admin' en _matudb_users).
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pf_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_vip BOOLEAN NOT NULL DEFAULT FALSE,
  vip_expires_at TIMESTAMPTZ,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wompi_vip_redemptions (
  reference TEXT PRIMARY KEY,
  wompi_transaction_id TEXT,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wompi_vip_redemptions_user_id ON wompi_vip_redemptions (user_id);

CREATE TABLE IF NOT EXISTS pf_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES pf_users (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pf_sessions_user_id ON pf_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_pf_sessions_expires_at ON pf_sessions (expires_at);

-- ───────────────────────────────────────────────────────────────────────────
-- Pagos / suscripciones (estructura — integración pasarela después)
-- ───────────────────────────────────────────────────────────────────────────

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

-- ───────────────────────────────────────────────────────────────────────────
-- Opcional — configuración clave/valor
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS system_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE,
  value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
