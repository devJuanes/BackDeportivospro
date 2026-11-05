-- Same as MatuStudio/Picks/docs/admin_ops.sql — keep in sync.
CREATE TABLE IF NOT EXISTS vip_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  message TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vip_requests_user_id ON vip_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_vip_requests_status_created
  ON vip_requests (status, created_at DESC);

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

ALTER TABLE IF EXISTS pf_users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
