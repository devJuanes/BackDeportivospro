-- In-app modal campaigns (MatuPicks admin → Flutter modal)
-- Run once on MatuDB / DeportivosPro Postgres.

CREATE TABLE IF NOT EXISTS app_modal_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT '',
  cta_url TEXT NOT NULL DEFAULT '',
  cta_route TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_modal_campaigns_active_window
  ON app_modal_campaigns (active, starts_at, ends_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_modal_campaigns_priority
  ON app_modal_campaigns (priority DESC, created_at DESC);
