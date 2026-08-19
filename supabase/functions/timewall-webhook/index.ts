/**
 * Star Follower — TimeWall Postback Edge Function
 *
 * TimeWall calls this URL server-to-server when a user completes an offer.
 *
 * ══════════════════════════════════════════════════════════════════
 *  PASTE THIS EXACT URL into TimeWall Dashboard → Placement → Postback URL:
 *
 *  https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/timewall-webhook?subid={userID}&payout={revenue}&tid={transactionID}&status={status}&secret=Admin%40Star77piyush%40%40%23%23RefreshedPass%40%23_%26%26_%23%40%2F%29%28%2B-
 *
 *  TimeWall macro mapping:
 *    {userID}        → the user's Supabase UUID (passed as &subid= in offerwall URL)
 *    {revenue}       → offer payout in USD  (e.g. "0.50")
 *    {transactionID} → unique transaction ID for deduplication
 *    {status}        → "credit" when the offer is approved
 * ══════════════════════════════════════════════════════════════════
 *
 * COIN CONVERSION RATE:
 *   $1.00 USD = 40,000 Coins
 *   $0.01 USD =    400 Coins   (COINS_PER_CENT = 400)
 *
 * DEPLOY (JWT verification MUST be disabled):
 *   Option A — CLI:
 *     supabase functions deploy timewall-webhook --no-verify-jwt
 *
 *   Option B — Dashboard (no CLI needed):
 *     1. Go to https://supabase.com/dashboard/project/lgqovwlmicjinwrteivn/functions
 *     2. Click "Create a new function" → name it exactly: timewall-webhook
 *     3. Paste this entire file into the editor
 *     4. IMPORTANT: toggle OFF "Enforce JWT Verification"
 *     5. Click Deploy
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Coin conversion: $1.00 USD = 40,000 coins ───────────────────────────────
const COINS_PER_CENT   = 400;   // $0.01 = 400 coins  →  $1.00 = 40,000 coins
const MIN_COINS        = 400;   // minimum coins credited per postback

const HARDCODED_SECRET = 'Admin@Star77piyush@@##RefreshedPass@#_&&_#@/)(+-';

serve(async (req: Request) => {
  // TimeWall treats any response other than HTTP 200 as a failure and retries.
  // We ALWAYS return HTTP 200 with body "1" — even on auth/validation errors.
  const OK = () => new Response('1', {
    status:  200,
    headers: { 'Content-Type': 'text/plain' },
  });

  try {
    const url = new URL(req.url);
    const p   = url.searchParams;

    // ── Parse parameters ───────────────────────────────────────────────────
    // URLSearchParams.get() auto-decodes %40→@ %23→# %26→& etc.

    const secret = p.get('secret') ?? '';

    // subid  = user UUID  (TimeWall macro: {userID})
    const subid = (
      p.get('subid') ??
      p.get('userID') ??
      p.get('userid') ??
      p.get('user_id') ??
      ''
    ).trim();

    // payout = USD amount (TimeWall macro: {revenue})
    const payout = parseFloat(
      p.get('payout')   ??
      p.get('revenue')  ??
      p.get('amount')   ??
      p.get('reward')   ??
      p.get('currency') ??
      '0'
    ) || 0;

    // tid = transaction ID (TimeWall macro: {transactionID})
    const tid = (
      p.get('tid')           ??
      p.get('transactionID') ??
      p.get('transaction_id') ??
      p.get('txn_id')        ??
      ''
    ).trim();

    // status: "credit" or "1" = approved; empty = assume approved
    const status = (p.get('status') ?? '').trim();

    console.log(
      `[timewall-webhook] IN  subid=${subid}  payout=${payout}  ` +
      `tid=${tid}  status="${status}"  secret_len=${secret.length}`
    );

    // ── 1. Secret validation ───────────────────────────────────────────────
    if (secret !== HARDCODED_SECRET) {
      console.error(
        `[timewall-webhook] ❌ Secret mismatch. ` +
        `got_len=${secret.length}  expected_len=${HARDCODED_SECRET.length}  ` +
        `got_start="${secret.slice(0, 8)}"  expected_start="${HARDCODED_SECRET.slice(0, 8)}"`
      );
      return OK(); // return OK so TimeWall doesn't retry indefinitely
    }

    // ── 2. Status check ────────────────────────────────────────────────────
    // Only credit on "credit", "1", or missing (direct credit postback).
    if (status !== '' && status !== 'credit' && status !== '1') {
      console.log(`[timewall-webhook] ⏭  Non-credit status="${status}" — skipping`);
      return OK();
    }

    // ── 3. Required field checks ───────────────────────────────────────────
    if (!subid) {
      console.error(
        '[timewall-webhook] ❌ Missing subid/userID — ' +
        'verify {userID} macro is set in TimeWall Placement settings'
      );
      return OK();
    }

    if (payout <= 0) {
      console.warn(`[timewall-webhook] ⚠️  payout=${payout} — skipping zero/negative payout`);
      return OK();
    }

    // ── 4. Supabase Service Role client (bypasses ALL RLS) ─────────────────
    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // ── 5. Deduplication — prevent double-crediting the same transaction ───
    if (tid) {
      const { error: dupErr } = await db
        .from('postback_log')
        .insert({ tid, user_id: subid, amount: payout });

      if (dupErr) {
        if (dupErr.code === '23505') {
          // UNIQUE violation — this tid was already credited
          console.log(`[timewall-webhook] ⏭  Duplicate tid=${tid} — already credited, skipping`);
          return OK();
        }
        // Any other error (e.g. table not created yet) — log but continue
        console.warn('[timewall-webhook] ⚠️  postback_log insert warning:', dupErr.message);
      }
    }

    // ── 6. Calculate coins ─────────────────────────────────────────────────
    // $1.00 USD = 40,000 coins  →  coins = payout × 100 × 400
    const cents = Math.round(payout * 100);
    const coins = Math.max(cents * COINS_PER_CENT, MIN_COINS);

    // ── 7. Credit coins via SECURITY DEFINER RPC ───────────────────────────
    const { data, error } = await db.rpc('sf_credit_coins_by_postback', {
      p_user_id: subid,
      p_coins:   coins,
    });

    if (error) {
      console.error(
        `[timewall-webhook] ❌ RPC error for user=${subid}:`,
        error.message,
        '| code:', error.code
      );
      return OK();
    }

    if (data?.error) {
      console.error(`[timewall-webhook] ❌ Business error for user=${subid}:`, data.error);
      return OK();
    }

    console.log(
      `[timewall-webhook] ✅ Credited ${coins.toLocaleString()} coins to user=${subid}` +
      `  (payout=$${payout}  cents=${cents}  rate=400/cent)`
    );
    return OK();

  } catch (err) {
    console.error('[timewall-webhook] ❌ Unhandled exception:', err);
    return OK(); // always return 1 so TimeWall doesn't retry
  }
});
