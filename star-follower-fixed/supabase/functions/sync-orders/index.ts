/**
 * Star Follower — Supabase Edge Function: sync-orders
 *
 * Checks non-terminal order statuses against the configured SMM Panel API
 * and updates them in the database with the raw status string the panel returns.
 * Supports multiple SMM panels — each service_index can have its own api_url/key.
 *
 * Deploy to Supabase:
 *   supabase functions deploy sync-orders
 *
 * Then add a pg_cron schedule in the Supabase SQL Editor:
 *   SELECT cron.schedule(
 *     'sync-orders-every-30min',
 *     '*/30 * * * *',
 *     $$
 *       SELECT net.http_post(
 *         url     := 'https://lgqovwlmicjinwrteivn.supabase.co/functions/v1/sync-orders',
 *         headers := '{"Authorization": "Bearer <YOUR_SERVICE_ROLE_KEY>"}'::jsonb,
 *         body    := '{}'::jsonb
 *       );
 *     $$
 *   );
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SRV_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Service names (mirrors supabase-api.js SERVICE_NAMES)
const SERVICE_NAMES = [
  'Instagram Followers [90 Days Guarantee]',
  'Instagram Followers [High Quality]',
  'Instagram Likes [90 Days Guarantee]',
  'Instagram Likes [Fast Delivery]',
  'Instagram Story Views',
  'Instagram Reel Views',
  'Instagram Post Views',
  'Instagram Saves',
  'Instagram Comments',
];

// Terminal statuses — orders in these states are never re-synced
const TERMINAL_STATUSES = ['Completed', 'Refilling', 'Partial', 'Canceled', 'Cancelled', 'Failed'];

type SmmStatusResp = {
  status?:      string;
  remains?:     number | string;
  start_count?: number | string;
  charge?:      string;
  error?:       string;
};

async function checkSmmOrderStatus(
  apiUrl: string,
  apiKey: string,
  externalOrderId: string,
): Promise<SmmStatusResp | null> {
  try {
    const body = new URLSearchParams({
      key:    apiKey,
      action: 'status',
      order:  externalOrderId,
    });

    const resp = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;
    return await resp.json() as SmmStatusResp;
  } catch {
    return null;
  }
}

/**
 * Normalise the raw SMM panel status to a consistent title-case string.
 * We pass through whatever the panel sends rather than mapping to a fixed
 * allowlist — this supports multiple panels with different naming conventions.
 */
function normaliseStatus(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Title-case: first letter upper, rest preserved
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

Deno.serve(async (_req) => {
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SRV_KEY, {
      auth: { persistSession: false },
    });

    // Sync all orders that:
    //   • have an external_order_id (placed on an SMM panel)
    //   • are NOT in a terminal status
    const { data: orders, error: ordErr } = await db
      .from('orders')
      .select('id, user_id, service_index, quantity, status, external_order_id')
      .not('external_order_id', 'is', null)
      .neq('external_order_id', '')
      .not('status', 'in', `(${TERMINAL_STATUSES.map(s => `"${s}"`).join(',')})`)
      .order('created_at', { ascending: false })
      .limit(200);

    if (ordErr) throw ordErr;
    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fetch all distinct service configs needed
    const serviceIdxSet = [...new Set(orders.map((o: Record<string, unknown>) => o.service_index as number))];
    const { data: configs, error: cfgErr } = await db
      .from('services_config')
      .select('service_index, api_url, api_key')
      .in('service_index', serviceIdxSet);

    if (cfgErr) throw cfgErr;

    const cfgMap: Record<number, { api_url: string; api_key: string }> = {};
    for (const c of (configs || []) as Array<Record<string, unknown>>) {
      cfgMap[c.service_index as number] = {
        api_url: c.api_url as string,
        api_key: c.api_key as string,
      };
    }

    let updated = 0;
    const results: string[] = [];

    for (const order of orders as Array<Record<string, unknown>>) {
      const cfg = cfgMap[order.service_index as number];
      if (!cfg || !cfg.api_url || !cfg.api_key) continue;

      const smmResp = await checkSmmOrderStatus(
        cfg.api_url,
        cfg.api_key,
        order.external_order_id as string,
      );

      if (!smmResp) continue;

      // Use the raw status string from the panel — no hardcoded mapping
      const newStatus = normaliseStatus(smmResp.status);
      if (!newStatus || newStatus === (order.status as string)) continue;

      // Build update payload
      const updatePayload: Record<string, unknown> = { status: newStatus };

      // Mark unnotified when order completes so the completion popup fires
      if (newStatus.toLowerCase() === 'completed') {
        updatePayload.notified = false;
      }

      // Persist remains if the column exists (no-op if it doesn't)
      if (smmResp.remains !== undefined && smmResp.remains !== null) {
        const remainsNum = parseInt(String(smmResp.remains), 10);
        if (!isNaN(remainsNum)) updatePayload.remains = remainsNum;
      }

      const { error: updErr } = await db
        .from('orders')
        .update(updatePayload)
        .eq('id', order.id as string);

      if (!updErr) {
        updated++;
        results.push(`Order ${order.id} (${SERVICE_NAMES[order.service_index as number] ?? 'service-' + order.service_index}): ${order.status} → ${newStatus}`);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, checked: orders.length, updated, results }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
