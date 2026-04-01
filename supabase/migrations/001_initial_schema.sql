-- ============================================================
-- Barber Agent — Schema inicial (idempotente — se puede re-ejecutar)
-- ============================================================

-- ─── TIPOS ────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM (
    'pending', 'confirmed', 'completed', 'cancelled', 'no_show'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('active', 'completed', 'abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── TABLA: barbers ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS barbers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  phone               TEXT NOT NULL,
  whatsapp_number     TEXT NOT NULL UNIQUE,
  shop_name           TEXT,
  location            TEXT,
  slot_duration_mins  INTEGER NOT NULL DEFAULT 30,
  google_tokens       JSONB,
  schedule            JSONB NOT NULL DEFAULT '{
    "lunes":     {"open": "09:00", "close": "18:00", "active": true},
    "martes":    {"open": "09:00", "close": "18:00", "active": true},
    "miercoles": {"open": "09:00", "close": "18:00", "active": true},
    "jueves":    {"open": "09:00", "close": "18:00", "active": true},
    "viernes":   {"open": "09:00", "close": "18:00", "active": true},
    "sabado":    {"open": "09:00", "close": "14:00", "active": true},
    "domingo":   {"open": "09:00", "close": "14:00", "active": false}
  }',
  services            JSONB NOT NULL DEFAULT '[
    {"name": "Corte", "price": 15, "duration_mins": 30},
    {"name": "Corte + Barba", "price": 25, "duration_mins": 45},
    {"name": "Barba", "price": 12, "duration_mins": 20},
    {"name": "Corte de niño", "price": 12, "duration_mins": 30}
  ]',
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── TABLA: clients ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barber_id   UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  last_visit  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (barber_id, phone)
);

-- ─── TABLA: appointments ──────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barber_id         UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service           TEXT NOT NULL,
  appointment_date  DATE NOT NULL,
  appointment_time  TIME NOT NULL,
  duration_mins     INTEGER NOT NULL DEFAULT 30,
  status            appointment_status NOT NULL DEFAULT 'confirmed',
  google_event_id   TEXT,
  channel           TEXT NOT NULL DEFAULT 'whatsapp',
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (barber_id, appointment_date, appointment_time)
);

-- ─── TABLA: blocked_slots ─────────────────────────────────
CREATE TABLE IF NOT EXISTS blocked_slots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barber_id     UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  blocked_date  DATE NOT NULL,
  blocked_from  TIME NOT NULL,
  blocked_to    TIME NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_time_range CHECK (blocked_from < blocked_to)
);

-- ─── TABLA: conversations ─────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barber_id     UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  client_phone  TEXT NOT NULL,
  messages      JSONB NOT NULL DEFAULT '[]',
  status        conversation_status NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (barber_id, client_phone, status)
);

-- ─── INDEXES ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_appointments_barber_date ON appointments(barber_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_barber_date ON blocked_slots(barber_id, blocked_date);
CREATE INDEX IF NOT EXISTS idx_clients_barber_phone ON clients(barber_id, phone);
CREATE INDEX IF NOT EXISTS idx_conversations_active ON conversations(barber_id, client_phone) WHERE status = 'active';

-- ─── FUNCIÓN: get_available_slots ─────────────────────────
-- Retorna los slots libres de un barbero en una fecha dada.
-- Llama con: SELECT * FROM get_available_slots('barber-uuid', '2025-04-05');
CREATE OR REPLACE FUNCTION get_available_slots(
  p_barber_id UUID,
  p_date      DATE
)
RETURNS TABLE(slot TIME) AS $$
DECLARE
  v_barber        barbers%ROWTYPE;
  v_day_name      TEXT;
  v_day_schedule  JSONB;
  v_open          TIME;
  v_close         TIME;
  v_duration      INTEGER;
  v_current       TIME;
BEGIN
  SELECT * INTO v_barber FROM barbers WHERE id = p_barber_id AND is_active = true;
  IF NOT FOUND THEN RETURN; END IF;

  v_day_name := CASE EXTRACT(DOW FROM p_date)
    WHEN 0 THEN 'domingo'
    WHEN 1 THEN 'lunes'
    WHEN 2 THEN 'martes'
    WHEN 3 THEN 'miercoles'
    WHEN 4 THEN 'jueves'
    WHEN 5 THEN 'viernes'
    WHEN 6 THEN 'sabado'
  END;

  v_day_schedule := v_barber.schedule -> v_day_name;

  IF NOT (v_day_schedule ->> 'active')::BOOLEAN THEN RETURN; END IF;

  v_open     := (v_day_schedule ->> 'open')::TIME;
  v_close    := (v_day_schedule ->> 'close')::TIME;
  v_duration := v_barber.slot_duration_mins;
  v_current  := v_open;

  WHILE v_current + (v_duration || ' minutes')::INTERVAL <= v_close LOOP
    IF NOT EXISTS (
      SELECT 1 FROM appointments
      WHERE barber_id       = p_barber_id
        AND appointment_date = p_date
        AND appointment_time = v_current
        AND status NOT IN ('cancelled', 'no_show')
    )
    AND NOT EXISTS (
      SELECT 1 FROM blocked_slots
      WHERE barber_id    = p_barber_id
        AND blocked_date = p_date
        AND v_current   >= blocked_from
        AND v_current   <  blocked_to
    )
    THEN
      slot := v_current;
      RETURN NEXT;
    END IF;

    v_current := v_current + (v_duration || ' minutes')::INTERVAL;
  END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─── RLS ──────────────────────────────────────────────────
ALTER TABLE barbers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Políticas (DROP + CREATE para ser idempotente)
DROP POLICY IF EXISTS "barber_own_data"         ON barbers;
DROP POLICY IF EXISTS "barber_own_clients"      ON clients;
DROP POLICY IF EXISTS "barber_own_appointments" ON appointments;
DROP POLICY IF EXISTS "barber_own_blocked_slots" ON blocked_slots;
DROP POLICY IF EXISTS "barber_own_conversations" ON conversations;

CREATE POLICY "barber_own_data" ON barbers
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "barber_own_clients" ON clients
  FOR ALL USING (
    barber_id IN (SELECT id FROM barbers WHERE user_id = auth.uid())
  );

CREATE POLICY "barber_own_appointments" ON appointments
  FOR ALL USING (
    barber_id IN (SELECT id FROM barbers WHERE user_id = auth.uid())
  );

CREATE POLICY "barber_own_blocked_slots" ON blocked_slots
  FOR ALL USING (
    barber_id IN (SELECT id FROM barbers WHERE user_id = auth.uid())
  );

CREATE POLICY "barber_own_conversations" ON conversations
  FOR ALL USING (
    barber_id IN (SELECT id FROM barbers WHERE user_id = auth.uid())
  );

-- El backend usa service_role key que bypasses RLS por diseño.
