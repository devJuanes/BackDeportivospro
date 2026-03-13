CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS abet (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT,
  league TEXT,
  home_team_name TEXT,
  home_team_logo TEXT,
  away_team_name TEXT,
  away_team_logo TEXT,
  prediction TEXT,
  confidence INTEGER,
  odds NUMERIC,
  match_date DATE,
  match_hour TEXT,
  state TEXT,
  rationale_short TEXT,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS abetvip (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT,
  league TEXT,
  home_team_name TEXT,
  home_team_logo TEXT,
  away_team_name TEXT,
  away_team_logo TEXT,
  prediction TEXT,
  confidence INTEGER,
  odds NUMERIC,
  match_date DATE,
  match_hour TEXT,
  state TEXT,
  rationale_short TEXT,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS sports_news (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  summary TEXT,
  url TEXT,
  image TEXT,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
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
