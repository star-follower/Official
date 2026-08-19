-- ============================================================
-- Star Follower — Migration: CPA Lead URL + Tutorial Video URL
-- ============================================================
-- Run this in your Supabase SQL Editor ONLY if you have an
-- older database that is missing Choice 2 / Tutorial Video
-- support in the admin config functions.
--
-- Safe to run on an already-updated database (uses DROP IF
-- EXISTS + DEFAULT parameters).
-- ============================================================

-- ── Ensure the app_config rows exist ────────────────────────
INSERT INTO app_config (key, value)
VALUES ('cpa_lead_url', '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_config (key, value)
VALUES ('tutorial_video_url', '')
ON CONFLICT (key) DO NOTHING;

-- ── Create a dedicated extra-config RPC (Strategy B helper) ─
-- This lets supabase-api.js save cpaLeadUrl and videoUrl even
-- if the main sf_admin_save_config is still the old 2-param version.
DROP FUNCTION IF EXISTS sf_admin_save_extra_config(TEXT, TEXT, TEXT);
CREATE FUNCTION sf_admin_save_extra_config(
  p_admin_token  TEXT,
  p_cpa_lead_url TEXT DEFAULT '',
  p_video_url    TEXT DEFAULT ''
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_sessions WHERE token = p_admin_token) THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;

  INSERT INTO app_config (key, value)
  VALUES ('cpa_lead_url', p_cpa_lead_url)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  INSERT INTO app_config (key, value)
  VALUES ('tutorial_video_url', p_video_url)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION sf_admin_save_extra_config TO anon;
GRANT EXECUTE ON FUNCTION sf_admin_save_extra_config TO service_role;

-- ── Upgrade sf_admin_get_config to include cpaLeadUrl / videoUrl ─
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
GRANT EXECUTE ON FUNCTION sf_admin_get_config TO anon;
GRANT EXECUTE ON FUNCTION sf_admin_get_config TO service_role;

-- ── Upgrade sf_admin_save_config to 4-param version ─────────
DROP FUNCTION IF EXISTS sf_admin_save_config(TEXT, TEXT);
DROP FUNCTION IF EXISTS sf_admin_save_config(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION sf_admin_save_config(
  p_admin_token   TEXT,
  p_offerwall_url TEXT DEFAULT '',
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
GRANT EXECUTE ON FUNCTION sf_admin_save_config TO anon;
GRANT EXECUTE ON FUNCTION sf_admin_save_config TO service_role;

-- ── Fix RLS policy to allow reading cpa_lead_url + tutorial_video_url ───────
-- Previously anon could only SELECT key='offerwall_url'.
-- This caused Choice 2 and the Tutorial Video to never appear on the Earn page.
DROP POLICY IF EXISTS "public_read_offerwall" ON app_config;
DROP POLICY IF EXISTS "public_read_config"    ON app_config;
CREATE POLICY "public_read_config" ON app_config
  FOR SELECT TO anon USING (key IN ('offerwall_url', 'cpa_lead_url', 'tutorial_video_url'));

-- ── sf_get_public_config — SECURITY DEFINER bypass for handleGetServices ────
-- Allows supabase-api.js to read all public config values even on databases
-- where the RLS policy has not yet been updated (belt-and-suspenders).
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
GRANT EXECUTE ON FUNCTION sf_get_public_config TO service_role;

-- ============================================================
-- DONE — Migration complete.
-- The Admin Portal can now save/load Choice 2 URL and
-- Tutorial Video URL correctly.
-- The Earn page now correctly displays the Tutorial Video
-- player at the top and the Choice 2 card.
-- ============================================================
