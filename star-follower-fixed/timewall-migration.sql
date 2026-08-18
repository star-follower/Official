-- ============================================================
-- Star Follower — TimeWall Integration SQL Migration
-- Run this script in your Supabase SQL Editor.
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT.
-- ============================================================

-- ── 1. postback_log table ────────────────────────────────────
-- Stores every credited transaction ID so duplicates are rejected.
-- The PRIMARY KEY on `tid` enforces uniqueness — duplicate inserts
-- return error code 23505 which the Edge Function catches.

CREATE TABLE IF NOT EXISTS postback_log (
  tid        TEXT        PRIMARY KEY,          -- unique transaction ID from TimeWall
  user_id    TEXT        NOT NULL,             -- Supabase user UUID (as TEXT for flexibility)
  amount     NUMERIC     NOT NULL DEFAULT 0,   -- USD payout amount for audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Block all direct anon access — only the Service Role (Edge Function) writes here
ALTER TABLE postback_log ENABLE ROW LEVEL SECURITY;

-- ── 2. sf_credit_coins_by_postback RPC ───────────────────────
-- Called by the timewall-webhook Edge Function using the Service Role key.
-- SECURITY DEFINER means it runs as the postgres superuser, bypassing RLS.
-- The shared secret is validated inside the Edge Function before this runs.

DROP FUNCTION IF EXISTS sf_credit_coins_by_postback(UUID, INTEGER);
CREATE FUNCTION sf_credit_coins_by_postback(
  p_user_id UUID,
  p_coins   INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF p_coins <= 0 THEN
    RETURN jsonb_build_object('error', 'Invalid coin amount');
  END IF;

  UPDATE users
     SET coins = coins + p_coins
   WHERE id = p_user_id
  RETURNING name INTO v_name;

  IF v_name IS NULL THEN
    RETURN jsonb_build_object('error', 'User not found: ' || p_user_id::TEXT);
  END IF;

  RETURN jsonb_build_object(
    'ok',       true,
    'user',     v_name,
    'credited', p_coins
  );
END;
$$;

-- Grant execute to both roles so the Edge Function can call it
-- regardless of which Supabase client role is active.
GRANT EXECUTE ON FUNCTION sf_credit_coins_by_postback TO anon;
GRANT EXECUTE ON FUNCTION sf_credit_coins_by_postback TO service_role;

-- ── 3. Store postback secret in app_config (optional audit row) ─
INSERT INTO app_config (key, value)
VALUES ('postback_secret', 'Admin@Star77piyush@@##RefreshedPass@#_&&_#@/)(+-')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================
-- DONE.
-- After running this script, deploy the Edge Function:
--
--   Option A (CLI):
--     supabase functions deploy timewall-webhook --no-verify-jwt
--
--   Option B (Dashboard — no CLI needed):
--     1. https://supabase.com/dashboard/project/lgqovwlmicjinwrteivn/functions
--     2. "Create a new function" → name: timewall-webhook
--     3. Paste supabase/functions/timewall-webhook/index.ts
--     4. Toggle OFF "Enforce JWT Verification"
--     5. Click Deploy
--
-- Postback URL (paste into TimeWall Dashboard → Placement → Postback URL):
--   https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/timewall-webhook?subid={userID}&payout={revenue}&tid={transactionID}&status={status}&secret=Admin%40Star77piyush%40%40%23%23RefreshedPass%40%23_%26%26_%23%40%2F%29%28%2B-
-- ============================================================
