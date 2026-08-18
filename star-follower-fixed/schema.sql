-- ============================================================
-- Star Follower — Complete Database Setup / Upgrade Script
-- Run this ENTIRE script in your Supabase SQL Editor.
-- Safe to re-run: uses DROP IF EXISTS + IF NOT EXISTS.
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TABLES (create-if-missing, safe on existing databases)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        UNIQUE NOT NULL CHECK (length(trim(name)) >= 2),
  password_hash TEXT        NOT NULL,
  coins         INTEGER     NOT NULL DEFAULT 50 CHECK (coins >= 0),
  recovery_code TEXT        UNIQUE NOT NULL DEFAULT floor(random() * 9000000000 + 1000000000)::BIGINT::TEXT,
  referral_code TEXT        UNIQUE NOT NULL DEFAULT upper(encode(gen_random_bytes(4), 'hex')),
  referred_by   UUID        REFERENCES users(id),
  device_id     TEXT        DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce one non-empty device UUID per account at the database level.
-- Empty legacy device IDs remain allowed until those accounts log in again.
CREATE UNIQUE INDEX IF NOT EXISTS users_device_id_unique
  ON users (device_id)
  WHERE device_id IS NOT NULL AND btrim(device_id) <> '';

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT        PRIMARY KEY DEFAULT encode(gen_random_bytes(32), 'hex'),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT        PRIMARY KEY DEFAULT encode(gen_random_bytes(32), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_index     INTEGER     NOT NULL,
  instagram_url     TEXT        NOT NULL,
  quantity          INTEGER     NOT NULL CHECK (quantity > 0),
  coin_cost         INTEGER     NOT NULL CHECK (coin_cost >= 0),
  status            TEXT        NOT NULL DEFAULT 'Pending',
  external_order_id TEXT,
  notified          BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe column migration for existing databases
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS services_config (
  service_index INTEGER PRIMARY KEY,
  api_url       TEXT    NOT NULL DEFAULT '',
  api_key       TEXT    NOT NULL DEFAULT '',
  service_id    TEXT    NOT NULL DEFAULT '',
  coin_cost     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Recovery codes are numeric and exactly 10 digits. Keep this default in
-- sync for databases created from an earlier version of this script.
ALTER TABLE users
  ALTER COLUMN recovery_code SET DEFAULT floor(random() * 9000000000 + 1000000000)::BIGINT::TEXT;

-- ============================================================
-- SEED DATA
-- ============================================================

INSERT INTO services_config (service_index)
VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8)
ON CONFLICT (service_index) DO NOTHING;

INSERT INTO app_config (key, value)
VALUES ('offerwall_url', '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value)
VALUES ('cpa_lead_url', '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value)
VALUES ('tutorial_video_url', '')
ON CONFLICT (key) DO NOTHING;

-- Default admin passcode: "admin123" — CHANGE THIS after first login
INSERT INTO app_config (key, value)
VALUES ('admin_passcode_hash', crypt('admin123', gen_salt('bf')))
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE services_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config      ENABLE ROW LEVEL SECURITY;

-- Drop old policies safely before recreating (avoids "already exists" errors)
DROP POLICY IF EXISTS "public_read_services"   ON services_config;
DROP POLICY IF EXISTS "public_read_offerwall"  ON app_config;

-- Allow anon to read service configs (needed for /api/services)
CREATE POLICY "public_read_services" ON services_config
  FOR SELECT TO anon USING (true);

-- Allow anon to read all public config keys
-- (offerwall_url, cpa_lead_url, tutorial_video_url)
DROP POLICY IF EXISTS "public_read_config" ON app_config;
CREATE POLICY "public_read_config" ON app_config
  FOR SELECT TO anon USING (key IN ('offerwall_url', 'cpa_lead_url', 'tutorial_video_url'));

-- ============================================================
-- RPC FUNCTIONS
-- All functions use SECURITY DEFINER (run as postgres superuser)
-- which bypasses RLS entirely — this is intentional and safe
-- because we validate tokens manually inside each function.
-- ============================================================

-- ─── Login / Signup ─────────────────────────────────────────

DROP FUNCTION IF EXISTS sf_login(TEXT, TEXT, TEXT);
CREATE FUNCTION sf_login(
  p_name      TEXT,
  p_password  TEXT,
  p_device_id TEXT DEFAULT ''
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user        users%ROWTYPE;
  v_token       TEXT;
  v_is_new      BOOLEAN := FALSE;
  v_device_cnt  INTEGER;
  v_suggestions TEXT[];
BEGIN
  SELECT * INTO v_user FROM users WHERE name = p_name;

  IF NOT FOUND THEN
    -- Enforce one account per device
    IF p_device_id <> '' THEN
      SELECT COUNT(*) INTO v_device_cnt FROM users WHERE device_id = p_device_id;
      IF v_device_cnt >= 1 THEN
        RETURN jsonb_build_object(
          'error', 'Only one account per device is allowed.',
          'type',  'device_locked'
        );
      END IF;
    END IF;

    -- Create new user (starts with 50 coins)
    BEGIN
      INSERT INTO users (name, password_hash, device_id)
      VALUES (trim(p_name), crypt(p_password, gen_salt('bf')), p_device_id)
      RETURNING * INTO v_user;
    EXCEPTION WHEN unique_violation THEN
      IF p_device_id <> '' THEN
        RETURN jsonb_build_object(
          'error', 'एक डिवाइस पर केवल एक ही अकाउंट बनाया जा सकता है।',
          'type',  'device_locked'
        );
      END IF;
      RAISE;
    END;

    v_is_new := TRUE;
  ELSE
    -- Validate password
    IF v_user.password_hash <> crypt(p_password, v_user.password_hash) THEN
      v_suggestions := ARRAY[
        p_name || floor(random() * 900  + 100 )::TEXT,
        p_name || '_'  || floor(random() * 99  + 1  )::TEXT,
        p_name || floor(random() * 9000 + 1000)::TEXT
      ];
      RETURN jsonb_build_object(
        'error',           'This name is already taken.',
        'type',            'name_taken',
        'nameSuggestions', to_jsonb(v_suggestions)
      );
    END IF;
  END IF;

  INSERT INTO sessions (user_id) VALUES (v_user.id) RETURNING token INTO v_token;

  RETURN jsonb_build_object(
    'userId',       v_user.id,
    'token',        v_token,
    'name',         v_user.name,
    'isNew',        v_is_new,
    'recoveryCode', CASE WHEN v_is_new THEN v_user.recovery_code ELSE NULL END
  );
END;
$$;

-- ─── Account Recovery ────────────────────────────────────────

DROP FUNCTION IF EXISTS sf_recover(TEXT, TEXT);
CREATE FUNCTION sf_recover(
  p_recovery_code TEXT,
  p_device_id     TEXT DEFAULT ''
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  users%ROWTYPE;
  v_token TEXT;
BEGIN
  SELECT * INTO v_user FROM users WHERE recovery_code = p_recovery_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Invalid recovery code.');
  END IF;

  IF p_device_id <> '' THEN
    UPDATE users SET device_id = p_device_id WHERE id = v_user.id;
  END IF;

  INSERT INTO sessions (user_id) VALUES (v_user.id) RETURNING token INTO v_token;

  RETURN jsonb_build_object(
    'userId', v_user.id,
    'token',  v_token,
    'name',   v_user.name
  );
END;
$$;

-- ─── Get User (with dashboard stats + referral count) ────────

DROP FUNCTION IF EXISTS sf_get_user(UUID, TEXT);
CREATE FUNCTION sf_get_user(p_user_id UUID, p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid               UUID;
  v_user              users%ROWTYPE;
  v_total_orders      BIGINT := 0;
  v_successful_orders BIGINT := 0;
  v_referrals         BIGINT := 0;
  v_new_completed     JSONB  := '[]'::JSONB;
BEGIN
  -- Validate token
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL OR v_uid <> p_user_id THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT * INTO v_user FROM users WHERE id = p_user_id;

  -- Dashboard stats
  SELECT COUNT(*)
    INTO v_total_orders
    FROM orders WHERE user_id = p_user_id;

  SELECT COUNT(*)
    INTO v_successful_orders
    FROM orders WHERE user_id = p_user_id AND status = 'Completed';

  -- Referral count: how many users registered using this user's referral code
  SELECT COUNT(*)
    INTO v_referrals
    FROM users WHERE referred_by = p_user_id;

  -- Newly completed orders not yet shown to user
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'orderId',      id,
      'serviceIndex', service_index,
      'quantity',     quantity,
      'status',       status
    )
  ), '[]'::JSONB)
  INTO v_new_completed
  FROM orders
  WHERE user_id  = p_user_id
    AND status   = 'Completed'
    AND notified = FALSE;

  -- Mark those orders as notified so they don't pop up again
  UPDATE orders
     SET notified = TRUE
   WHERE user_id = p_user_id
     AND status  = 'Completed'
     AND notified = FALSE;

  RETURN jsonb_build_object(
    'id',               v_user.id,
    'name',             v_user.name,
    'coins',            v_user.coins,
    'referralCode',     v_user.referral_code,
    'referredBy',       v_user.referred_by,
    'createdAt',        v_user.created_at,
    'totalOrders',      v_total_orders,
    'successfulOrders', v_successful_orders,
    'referrals',        v_referrals,
    'newCompleted',     v_new_completed
  );
END;
$$;

-- ─── Get All Orders for a User (RPC — bypasses RLS) ──────────
--
-- KEY FIX: Previously supabase-api.js did a direct anon-key
-- SELECT on the `sessions` table, which RLS blocked (no anon
-- policy exists). Moving this into a SECURITY DEFINER function
-- lets it run as postgres (superuser) → bypasses RLS.

DROP FUNCTION IF EXISTS sf_get_orders(TEXT);
CREATE FUNCTION sf_get_orders(p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID;
  v_rows JSONB;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'orderId',         id,
      'serviceIndex',    service_index,
      'instagramUrl',    instagram_url,
      'quantity',        quantity,
      'coinCost',        coin_cost,
      'status',          status,
      'externalOrderId', COALESCE(external_order_id, ''),
      'createdAt',       created_at
    ) ORDER BY created_at DESC
  ), '[]'::JSONB)
  INTO v_rows
  FROM orders
  WHERE user_id = v_uid;

  RETURN v_rows;
END;
$$;

-- ─── Get Single Order (RPC — bypasses RLS) ───────────────────

DROP FUNCTION IF EXISTS sf_get_order(TEXT, UUID);
CREATE FUNCTION sf_get_order(p_token TEXT, p_order_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID;
  v_row orders%ROWTYPE;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT * INTO v_row
    FROM orders
   WHERE id = p_order_id AND user_id = v_uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;

  RETURN jsonb_build_object(
    'orderId',         v_row.id,
    'serviceIndex',    v_row.service_index,
    'instagramUrl',    v_row.instagram_url,
    'quantity',        v_row.quantity,
    'coinCost',        v_row.coin_cost,
    'status',          v_row.status,
    'externalOrderId', COALESCE(v_row.external_order_id, ''),
    'createdAt',       v_row.created_at
  );
END;
$$;

-- ─── Add Coins (offerwall callback) ──────────────────────────

DROP FUNCTION IF EXISTS sf_add_coins(TEXT, INTEGER);
CREATE FUNCTION sf_add_coins(p_token TEXT, p_amount INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'Invalid amount');
  END IF;

  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  UPDATE users SET coins = coins + p_amount WHERE id = v_uid;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ─── Place Order ─────────────────────────────────────────────

DROP FUNCTION IF EXISTS sf_place_order(TEXT, INTEGER, TEXT, INTEGER);
DROP FUNCTION IF EXISTS sf_place_order(TEXT, INTEGER, TEXT, INTEGER, TEXT);
CREATE FUNCTION sf_place_order(
  p_token              TEXT,
  p_service_index      INTEGER,
  p_instagram_url      TEXT,
  p_quantity           INTEGER,
  p_external_order_id  TEXT DEFAULT ''
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid            UUID;
  v_coins          INTEGER;
  v_cfg            services_config%ROWTYPE;
  v_cost           INTEGER;
  v_order_id       UUID;
  v_referrer_id    UUID;
  v_lifetime_prev  INTEGER;
  v_lifetime_new   INTEGER;
  v_milestone      INTEGER := 2000;
  v_referrer_bonus INTEGER := 1000;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT * INTO v_cfg FROM services_config WHERE service_index = p_service_index;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Invalid service');
  END IF;

  -- Allow placing order even if coin_cost = 0 (service configured without price)
  v_cost := GREATEST(p_quantity * v_cfg.coin_cost, 0);

  SELECT coins INTO v_coins FROM users WHERE id = v_uid;
  IF v_coins < v_cost THEN
    RETURN jsonb_build_object('error', 'Not enough coins');
  END IF;

  -- Deduct coins and write order atomically
  UPDATE users SET coins = coins - v_cost WHERE id = v_uid;

  INSERT INTO orders (user_id, service_index, instagram_url, quantity, coin_cost, status, external_order_id)
  VALUES (v_uid, p_service_index, p_instagram_url, p_quantity, v_cost, 'Pending',
          NULLIF(trim(p_external_order_id), ''))
  RETURNING id INTO v_order_id;

  -- Referrer milestone: credit 1000 coins when friend's lifetime spend crosses 2000
  SELECT referred_by INTO v_referrer_id FROM users WHERE id = v_uid;
  IF v_referrer_id IS NOT NULL THEN
    SELECT COALESCE(SUM(coin_cost), 0)
      INTO v_lifetime_prev
      FROM orders
     WHERE user_id = v_uid AND id <> v_order_id;

    v_lifetime_new := v_lifetime_prev + v_cost;

    IF v_lifetime_prev < v_milestone AND v_lifetime_new >= v_milestone THEN
      UPDATE users SET coins = coins + v_referrer_bonus WHERE id = v_referrer_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'orderId',      v_order_id,
    'serviceIndex', p_service_index,
    'instagramUrl', p_instagram_url,
    'quantity',     p_quantity,
    'coinCost',     v_cost,
    'status',       'Pending',
    'createdAt',    NOW()
  );
END;
$$;

-- ─── Get Bulk Refill Candidates ──────────────────────────────
-- Returns all orders for the same instagram URL that are:
--   • placed by the authenticated user
--   • under a 90-Day Guarantee service (service_index IN 0, 2)
--   • created within the last 90 days
--   • have an external SMM order ID
--   • not already in 'Refilling' status
-- Used by supabase-api.js handleRefillOrder for bulk 1-click refill.

DROP FUNCTION IF EXISTS sf_get_refill_candidates(TEXT, TEXT);
CREATE FUNCTION sf_get_refill_candidates(p_token TEXT, p_instagram_url TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid  UUID;
  v_rows JSONB;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'orderId',         id,
      'serviceIndex',    service_index,
      'instagramUrl',    instagram_url,
      'quantity',        quantity,
      'externalOrderId', COALESCE(external_order_id, ''),
      'createdAt',       created_at,
      'status',          status
    ) ORDER BY created_at DESC
  ), '[]'::JSONB)
  INTO v_rows
  FROM orders
  WHERE user_id         = v_uid
    AND instagram_url   = p_instagram_url
    AND service_index   IN (0, 2)
    AND created_at      >= NOW() - INTERVAL '90 days'
    AND external_order_id IS NOT NULL
    AND external_order_id <> ''
    AND status          <> 'Refilling';

  RETURN v_rows;
END;
$$;

GRANT EXECUTE ON FUNCTION sf_get_refill_candidates TO anon;

-- ─── Set External Order ID (called after SMM placement succeeds) ───────────
-- Allows supabase-api.js to attach the SMM panel's order ID to a Supabase
-- order row after the fact, without exposing the orders table to direct
-- anon writes (RLS blocks those).

DROP FUNCTION IF EXISTS sf_set_external_order_id(TEXT, UUID, TEXT);
CREATE FUNCTION sf_set_external_order_id(
  p_token             TEXT,
  p_order_id          UUID,
  p_external_order_id TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   UUID;
  v_found BOOLEAN;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  UPDATE orders
     SET external_order_id = p_external_order_id
   WHERE id = p_order_id AND user_id = v_uid
  RETURNING TRUE INTO v_found;

  IF NOT v_found THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION sf_set_external_order_id TO anon;

-- ─── Refill Order ─────────────────────────────────────────────

DROP FUNCTION IF EXISTS sf_refill_order(TEXT, UUID);
CREATE FUNCTION sf_refill_order(p_token TEXT, p_order_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID;
  v_found BOOLEAN;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  UPDATE orders SET status = 'Refilling'
   WHERE id = p_order_id AND user_id = v_uid
  RETURNING TRUE INTO v_found;

  IF NOT v_found THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ─── Apply Referral ───────────────────────────────────────────

DROP FUNCTION IF EXISTS sf_apply_referral(TEXT, TEXT);
CREATE FUNCTION sf_apply_referral(p_token TEXT, p_referral_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid      UUID;
  v_ref_user users%ROWTYPE;
BEGIN
  SELECT user_id INTO v_uid FROM sessions WHERE token = p_token;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT * INTO v_ref_user
    FROM users
   WHERE referral_code = upper(trim(p_referral_code));

  IF NOT FOUND OR v_ref_user.id = v_uid THEN
    RETURN jsonb_build_object('error', 'Invalid referral code');
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE id = v_uid AND referred_by IS NOT NULL) THEN
    RETURN jsonb_build_object('error', 'Already applied a referral');
  END IF;

  -- New friend gets 200 coins instantly
  UPDATE users
     SET referred_by = v_ref_user.id,
         coins       = coins + 200
   WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true, 'coinsAwarded', 200);
END;
$$;

-- ─── Admin: Verify Passcode ───────────────────────────────────

DROP FUNCTION IF EXISTS sf_verify_admin(TEXT);
CREATE FUNCTION sf_verify_admin(p_passcode TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hash  TEXT;
  v_token TEXT;
BEGIN
  SELECT value INTO v_hash FROM app_config WHERE key = 'admin_passcode_hash';

  IF v_hash IS NULL OR v_hash <> crypt(p_passcode, v_hash) THEN
    RETURN jsonb_build_object('error', 'Invalid passcode');
  END IF;

  INSERT INTO admin_sessions DEFAULT VALUES RETURNING token INTO v_token;
  RETURN jsonb_build_object('token', v_token);
END;
$$;

-- ─── Admin: Get Config ────────────────────────────────────────

DROP FUNCTION IF EXISTS sf_admin_get_config(TEXT);
CREATE FUNCTION sf_admin_get_config(p_admin_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offerwall TEXT;
  v_cpa_lead  TEXT;
  v_video_url TEXT;
  v_services  JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_sessions WHERE token = p_admin_token) THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  SELECT value INTO v_offerwall FROM app_config WHERE key = 'offerwall_url';
  SELECT value INTO v_cpa_lead  FROM app_config WHERE key = 'cpa_lead_url';
  SELECT value INTO v_video_url FROM app_config WHERE key = 'tutorial_video_url';

  SELECT jsonb_agg(
    jsonb_build_object(
      'serviceIndex', service_index,
      'apiUrl',       api_url,
      'apiKey',       api_key,
      'serviceId',    service_id,
      'coinCost',     coin_cost
    ) ORDER BY service_index
  ) INTO v_services FROM services_config;

  RETURN jsonb_build_object(
    'offerwallUrl', COALESCE(v_offerwall, ''),
    'cpaLeadUrl',   COALESCE(v_cpa_lead,  ''),
    'videoUrl',     COALESCE(v_video_url, ''),
    'services',     COALESCE(v_services, '[]'::JSONB)
  );
END;
$$;

-- ─── Admin: Save Config ───────────────────────────────────────

DROP FUNCTION IF EXISTS sf_admin_save_config(TEXT, TEXT);
DROP FUNCTION IF EXISTS sf_admin_save_config(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION sf_admin_save_config(
  p_admin_token   TEXT,
  p_offerwall_url TEXT,
  p_cpa_lead_url  TEXT DEFAULT '',
  p_video_url     TEXT DEFAULT ''
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_sessions WHERE token = p_admin_token) THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  INSERT INTO app_config (key, value)
  VALUES ('offerwall_url', p_offerwall_url)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  INSERT INTO app_config (key, value)
  VALUES ('cpa_lead_url', p_cpa_lead_url)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  INSERT INTO app_config (key, value)
  VALUES ('tutorial_video_url', p_video_url)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ─── Admin: Save Service Config ───────────────────────────────

DROP FUNCTION IF EXISTS sf_admin_save_service(TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER);
CREATE FUNCTION sf_admin_save_service(
  p_admin_token   TEXT,
  p_service_index INTEGER,
  p_api_url       TEXT,
  p_api_key       TEXT,
  p_service_id    TEXT,
  p_coin_cost     INTEGER
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_sessions WHERE token = p_admin_token) THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  INSERT INTO services_config (service_index, api_url, api_key, service_id, coin_cost)
  VALUES (p_service_index, p_api_url, p_api_key, p_service_id, p_coin_cost)
  ON CONFLICT (service_index) DO UPDATE SET
    api_url    = EXCLUDED.api_url,
    api_key    = EXCLUDED.api_key,
    service_id = EXCLUDED.service_id,
    coin_cost  = EXCLUDED.coin_cost;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================
-- GRANTS — allow anon role to execute all sf_ functions
-- ============================================================

GRANT EXECUTE ON FUNCTION sf_login              TO anon;
GRANT EXECUTE ON FUNCTION sf_recover            TO anon;
GRANT EXECUTE ON FUNCTION sf_get_user           TO anon;
GRANT EXECUTE ON FUNCTION sf_get_orders         TO anon;
GRANT EXECUTE ON FUNCTION sf_get_order          TO anon;
GRANT EXECUTE ON FUNCTION sf_add_coins          TO anon;
GRANT EXECUTE ON FUNCTION sf_place_order        TO anon;
GRANT EXECUTE ON FUNCTION sf_refill_order       TO anon;
GRANT EXECUTE ON FUNCTION sf_apply_referral     TO anon;
GRANT EXECUTE ON FUNCTION sf_verify_admin       TO anon;
GRANT EXECUTE ON FUNCTION sf_admin_get_config   TO anon;
GRANT EXECUTE ON FUNCTION sf_admin_save_config  TO anon;
GRANT EXECUTE ON FUNCTION sf_admin_save_service TO anon;

-- ─── Public Config (bypasses RLS — reads all public config keys) ───────────
-- Called by supabase-api.js handleGetServices to reliably fetch cpa_lead_url
-- and tutorial_video_url regardless of the anon RLS policy on app_config.

DROP FUNCTION IF EXISTS sf_get_public_config();
CREATE FUNCTION sf_get_public_config()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offerwall TEXT;
  v_cpa_lead  TEXT;
  v_video_url TEXT;
BEGIN
  SELECT value INTO v_offerwall FROM app_config WHERE key = 'offerwall_url';
  SELECT value INTO v_cpa_lead  FROM app_config WHERE key = 'cpa_lead_url';
  SELECT value INTO v_video_url FROM app_config WHERE key = 'tutorial_video_url';
  RETURN jsonb_build_object(
    'offerwallUrl', COALESCE(v_offerwall, ''),
    'cpaLeadUrl',   COALESCE(v_cpa_lead,  ''),
    'videoUrl',     COALESCE(v_video_url, '')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION sf_get_public_config TO anon;

-- ─── Postback Log (CPAlead deduplication) ────────────────────
-- Prevents the same CPAlead transaction from being credited twice.
-- The tid column has a UNIQUE constraint — duplicate inserts fail fast.

CREATE TABLE IF NOT EXISTS postback_log (
  tid        TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL,
  amount     NUMERIC     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Block all direct anon access — only Service Role (Edge Function) writes here
ALTER TABLE postback_log ENABLE ROW LEVEL SECURITY;

-- ─── Credit Coins by User ID (CPAlead postback) ──────────────
-- Called by the cpalead-postback Edge Function using the
-- Service Role key (which bypasses RLS automatically).
-- A shared secret is validated inside the Edge Function
-- before this is ever called — no extra auth needed here.

DROP FUNCTION IF EXISTS sf_credit_coins_by_postback(UUID, INTEGER);
CREATE FUNCTION sf_credit_coins_by_postback(
  p_user_id UUID,
  p_coins   INTEGER
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF p_coins <= 0 THEN
    RETURN jsonb_build_object('error', 'Invalid coin amount');
  END IF;

  UPDATE users SET coins = coins + p_coins
   WHERE id = p_user_id
  RETURNING name INTO v_name;

  IF v_name IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'user', v_name, 'credited', p_coins);
END;
$$;

GRANT EXECUTE ON FUNCTION sf_credit_coins_by_postback TO anon;
GRANT EXECUTE ON FUNCTION sf_credit_coins_by_postback TO service_role;

-- ─── Get User ID from Session Token (used by supabase-api.js) ────────────
-- SECURITY DEFINER bypasses RLS so the anon key can look up a session.
DROP FUNCTION IF EXISTS sf_get_user_id_from_token(TEXT);
CREATE FUNCTION sf_get_user_id_from_token(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT user_id INTO v_user_id FROM sessions WHERE token = p_token;
  RETURN v_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION sf_get_user_id_from_token TO anon;

-- Set postback secret (matches HARDCODED_SECRET in the Edge Function)
-- ON CONFLICT DO UPDATE overwrites any previous value, including 'CHANGE_ME_TO_RANDOM_SECRET'
INSERT INTO app_config (key, value)
VALUES ('postback_secret', 'Admin@Star77piyush@@##RefreshedPass@#_&&_#@/)(+-')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================
-- OPTIONAL: Automated SMM Status Sync via pg_cron
-- Uncomment after deploying the sync-orders Edge Function.
-- ============================================================
-- SELECT cron.schedule(
--   'sync-orders-every-30min',
--   '*/30 * * * *',
--   $$
--     SELECT net.http_post(
--       url     := 'https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/sync-orders',
--       headers := '{"Authorization": "Bearer <YOUR_SERVICE_ROLE_KEY>", "Content-Type": "application/json"}'::jsonb,
--       body    := '{}'::jsonb
--     );
--   $$
-- );

-- ============================================================
-- DONE.
-- Default admin passcode: admin123  (change via app_config table)
-- ============================================================
