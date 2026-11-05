-- Ver schema-deportivospro.sql (esquema canónico DeportivosPro API / MatuDB PostgreSQL)
-- Ejecutar: npm run db:migrate

-- ─── Solicitudes de acceso VIP (app Flutter) ───────────────────────────────

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
CREATE INDEX IF NOT EXISTS idx_vip_requests_status_created ON vip_requests (status, created_at DESC);
