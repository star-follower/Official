-- ────────────────────────────────────────────────────────────────────────────
-- Star Follower — Order Status Migration
-- Run this ONCE in the Supabase SQL Editor.
-- Adds sf_update_order_status — called by supabase-api.js when the browser
-- fetches a live status from the SMM panel and needs to persist it.
-- ────────────────────────────────────────────────────────────────────────────

-- Allows the browser API layer (anon key) to write the SMM panel's status
-- string back to the orders table without exposing direct anon table writes.
CREATE OR REPLACE FUNCTION sf_update_order_status(
  p_token    TEXT,
  p_order_id UUID,
  p_status   TEXT
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
     SET status = p_status
   WHERE id = p_order_id AND user_id = v_uid
  RETURNING TRUE INTO v_found;

  IF NOT v_found THEN
    RETURN jsonb_build_object('error', 'Order not found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', p_status);
END;
$$;

GRANT EXECUTE ON FUNCTION sf_update_order_status TO anon;
