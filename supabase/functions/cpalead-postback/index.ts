/**
 * Star Follower — CPAlead Postback Edge Function
 *
 * CPAlead calls this URL server-to-server when a user completes an offer.
 *
 * ── CRITICAL: Use this EXACT Postback URL in CPAlead dashboard ───────────
 *
 *   https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/cpalead-postback
 *     ?subid={SUBID}
 *     &amount={AMOUNT}
 *     &tid={TRANSACTION_ID}
 *     &status={STATUS}
 *     &secret=Admin%40Star77piyush%40%40%23%23RefreshedPass%40%23_%26%26_%23%40%2F%29%28%2B-
 *
 *   ⚠️  The secret MUST be pasted URL-encoded (the %40/%23/%26 version above).
 *       If you paste the raw secret with & and # characters, it breaks the URL
 *       and the request never arrives correctly.
 *
 * ── Deploy via Supabase Dashboard (no CLI needed) ───────────────────────
 *   1. Go to https://supabase.com/dashboard/project/lgqovwlmicjinwrteivn/functions
 *   2. Click "Create a new function"  → name it  cpalead-postback
 *   3. Paste this entire file into the editor and click Deploy
 *
 * ── Coin conversion ──────────────────────────────────────────────────────
 *   1 CPAlead virtual-currency unit → COINS_PER_UNIT coins (default: 10)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const COINS_PER_UNIT = 10;
const MIN_COINS      = 10;

// The raw secret (decoded). Must match app_config row  key = 'postback_secret'.
// URLSearchParams.get() automatically URL-decodes, so if CPAlead sends the
// %40/%23/%26-encoded version, we still get back the original string here.
const HARDCODED_SECRET = 'Admin@Star77piyush@@##RefreshedPass@#_&&_#@/)(+-';

serve(async (req: Request) => {
  const url = new URL(req.url);
  const p   = url.searchParams;

  // URLSearchParams.get() auto-decodes %40 → @, %26 → &, %23 → # etc.
  const secret = p.get('secret') ?? '';
  const subid  = (p.get('subid')  ?? '').trim();
  const amount = parseFloat(p.get('amount') ?? '1') || 1;
  const tid    = (p.get('tid') ?? p.get('transaction_id') ?? '').trim();
  const status = (p.get('status') ?? '1').trim();

  console.log(`[postback] IN subid=${subid} amount=${amount} tid=${tid} status=${status} secret_len=${secret.length}`);

  // Always return "1" — CPAlead treats any other response as failure and retries
  const OK = new Response('1', { status: 200, headers: { 'Content-Type': 'text/plain' } });

  // ── Secret validation ────────────────────────────────────────────────────
  // Validate against hardcoded value first (fast), then fall back to DB value.
  // If neither matches, reject with a log so you can debug via Edge Function logs.
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  let expectedSecret = HARDCODED_SECRET;
  try {
    const { data } = await db
      .from('app_config')
      .select('value')
      .eq('key', 'postback_secret')
      .single();
    if (data?.value) expectedSecret = data.value;
  } catch (_) {
    // app_config unavailable — fall back to HARDCODED_SECRET above
  }

  if (secret !== expectedSecret) {
    console.error(
      `[postback] ❌ Secret mismatch. ` +
      `Received length=${secret.length}, expected length=${expectedSecret.length}. ` +
      `First 6 chars received: "${secret.slice(0, 6)}" expected: "${expectedSecret.slice(0, 6)}"`
    );
    // Return OK so CPAlead doesn't retry indefinitely on a permanent auth failure
    return OK;
  }

  // ── Status check ─────────────────────────────────────────────────────────
  if (status !== '1') {
    console.log(`[postback] Non-approved status=${status}, skipping`);
    return OK;
  }

  if (!subid) {
    console.error('[postback] Missing subid — verify CPAlead {SUBID} macro is configured');
    return OK;
  }

  // ── Deduplication ────────────────────────────────────────────────────────
  if (tid) {
    const { error: dupErr } = await db
      .from('postback_log')
      .insert({ tid, user_id: subid, amount });

    if (dupErr) {
      if (dupErr.code === '23505') {
        console.log(`[postback] Duplicate tid=${tid}, already credited — skipping`);
        return OK;
      }
      console.warn('[postback] postback_log insert warning (non-fatal):', dupErr.message);
    }
  }

  // ── Credit coins ─────────────────────────────────────────────────────────
  const coins = Math.max(Math.round(amount * COINS_PER_UNIT), MIN_COINS);

  const { data: rpcData, error: rpcErr } = await db.rpc('sf_credit_coins_by_postback', {
    p_user_id: subid,
    p_coins:   coins,
  });

  if (rpcErr) {
    console.error(`[postback] ❌ RPC error for user=${subid}:`, rpcErr.message, 'code:', rpcErr.code);
    return OK;
  }

  if (rpcData?.error) {
    console.error(`[postback] ❌ Business error for user=${subid}:`, rpcData.error);
    return OK;
  }

  console.log(`[postback] ✅ Credited ${coins} coins to user=${subid} (cpalead_amount=${amount})`);
  return OK;
});
