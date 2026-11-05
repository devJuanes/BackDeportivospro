-- VIP access requests (MatuPicks Flutter "Solicitar VIP")
-- Run once against the MatuDB / DeportivosPro Postgres project.

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

CREATE INDEX IF NOT EXISTS idx_vip_requests_user_id
  ON vip_requests (user_id);

CREATE INDEX IF NOT EXISTS idx_vip_requests_status_created
  ON vip_requests (status, created_at DESC);

-- Optional: at most one pending request per user (Postgres 15+ partial unique).
-- Uncomment if your MatuDB Postgres version supports it:
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_vip_requests_user_pending
--   ON vip_requests (user_id) WHERE status = 'pending';
