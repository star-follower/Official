/**
 * Star Follower — CPAlead Webhook / Postback Edge Function
 *
 * This function handles server-to-server postback calls from CPAlead when a
 * user completes an offer on the Reward Wall.
 *
 * ── EXACT Postback URL to paste in CPAlead Dashboard ────────────────────
 *
 *   https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/cpalead-webhook
 *     ?subid={SUBID}
 *     &amount={AMOUNT}
 *     &tid={TRANSACTION_ID}
 *     &status={STATUS}
 *     &secret=Admin%40Star77piyush%40%40%23%23RefreshedPass%40%23_%26%26_%23%40%2F%29%28%2B-
 *
 *   One line (no line breaks):
 *   https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/cpalead-webhook?subid={SUBID}&amount={AMOUNT}&tid={TRANSACTION_ID}&status={STATUS}&secret=Admin%40Star77piyush%40%40%23%23RefreshedPass%40%23_%26%26_%23%40%2F%29%28%2B-
 *
 * ── Deploy (MUST include --no-verify-jwt) ───────────────────────────────
 *   supabase functions deploy cpalead-webhook --no-verify-jwt
 *
 *   OR via Dashboard: Edge Functions → New Function → paste this file →
 *   toggle OFF "Enforce JWT Verification" → Deploy
 *
 * ── Coin conversion ──────────────────────────────────────────────────────
 *   1 CPAlead virtual-currency unit → 10 coins (min 10 per postback)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const COINS_PER_UNIT  = 10;
const MIN_COINS       = 10;
const HARDCODED_SECRET = 'Admin@Star77piyush@@##RefreshedPass@#_&&_#@/)(+-';

serve(async (req: Request) => {
  // Always return "1" — CPAlead treats anything else as failure and retries
  const OK = () => new Response('1', {
    status:  200,
    headers: { 'Content-Type': 'text/plain' },
  });

  try {
    const url = new URL(req.url);
    const p   = url.searchParams;

    // URLSearchParams.get() auto-decodes %40→@ %23→# %26→& etc.
    const secret = p.get('secret') ?? '';
    const subid  = (p.get('subid')  ?? '').trim();
    const amount = parseFloat(p.get('amount') ?? '1') || 1;
    const tid    = (p.get('tid') ?? p.get('transaction_id') ?? '').trim();
    const status = (p.get('status') ?? '1').trim();

    console.log(`[cpalead-webhook] IN subid=${subid} amount=${amount} tid=${tid} status=${status} secret_len=${secret.length}`);

    // ── Secret validation ────────────────────────────────────────────────
    // The Supabase Service Role client is used later — this secret check is
    // an extra layer to block spoofed requests before any DB work is done.
    if (secret !== HARDCODED_SECRET) {
      console.error(
        `[cpalead-webhook] ❌ Secret mismatch. ` +
        `got_len=${secret.length} expected_len=${HARDCODED_SECRET.length} ` +
        `got_start="${secret.slice(0, 8)}" expected_start="${HARDCODED_SECRET.slice(0, 8)}"`
      );
      // Return OK so CPAlead doesn't retry indefinitely on a permanent auth failure
      return OK();
    }

    // ── Status check — only credit approved conversions ──────────────────
    if (status !== '1') {
      console.log(`[cpalead-webhook] Skipped non-approved status=${status}`);
      return OK();
    }

    if (!subid) {
      console.error('[cpalead-webhook] Missing subid — check CPAlead {SUBID} macro');
      return OK();
    }

    // ── Supabase Service Role client (bypasses ALL RLS) ──────────────────
    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // ── Deduplication — prevent double-crediting the same transaction ────
    if (tid) {
      const { error: dupErr } = await db
        .from('postback_log')
        .insert({ tid, user_id: subid, amount });

      if (dupErr) {
        if (dupErr.code === '23505') {
          console.log(`[cpalead-webhook] Duplicate tid=${tid} — already credited`);
          return OK();
        }
        // postback_log table might not exist yet — log and continue (don't block crediting)
        console.warn('[cpalead-webhook] postback_log insert warning:', dupErr.message);
      }
    }

    // ── Credit coins via SECURITY DEFINER function ───────────────────────
    const coins = Math.max(Math.round(amount * COINS_PER_UNIT), MIN_COINS);

    const { data, error } = await db.rpc('sf_credit_coins_by_postback', {
      p_user_id: subid,
      p_coins:   coins,
    });

    if (error) {
      console.error(`[cpalead-webhook] ❌ RPC error user=${subid}:`, error.message, 'code:', error.code);
      return OK();
    }

    if (data?.error) {
      console.error(`[cpalead-webhook] ❌ Business error user=${subid}:`, data.error);
      return OK();
    }

    console.log(`[cpalead-webhook] ✅ Credited ${coins} coins to user=${subid} (cpalead_amount=${amount})`);
    return OK();

  } catch (err) {
    console.error('[cpalead-webhook] Unhandled exception:', err);
    return OK(); // always return 1 so CPAlead doesn't retry
  }
});
