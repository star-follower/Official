/**
 * Star Follower — Supabase Direct API Layer
 * Intercepts all /api/* fetch calls and translates them into
 * direct Supabase database calls. Runs before the main bundle.
 *
 * v2.1 — Robust fallback for old RPC signatures (cpaLeadUrl / videoUrl)
 */
(function () {
  'use strict';

  var SUPABASE_URL      = 'https://lgqovwlmicjinwrteivn.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxncW92d2xtaWNqaW53cnRlaXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzOTI2NzAsImV4cCI6MjA5Nzk2ODY3MH0.uFU2sczoAZYUcVdZQG-8IGizw2XfFlRY7sbxqaPuEzs';

  // Supabase JS is loaded via CDN in index.html before this script
  var db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ─── service name map (mirrors the bundle's IA array) ───────────────────────
  var SERVICE_NAMES = [
    'Instagram Followers',
    'Instagram Repost',
    'Instagram Reel Share',
    'Instagram Likes [Fast Delivery]',
    'Instagram Story Views',
    'Instagram Reel Views',
    'Instagram Post Views',
    'Instagram Reel Share',
    'Instagram Comments'
  ];

  // Service indices that carry the 90-day refill guarantee
  var GUARANTEE_INDICES = [];

  function getServiceName(idx) {
    return SERVICE_NAMES[idx] || ('Service #' + idx);
  }

  function isGuaranteeService(idx) {
    return GUARANTEE_INDICES.indexOf(idx) !== -1;
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  function jsonRes(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function errRes(msg, status) {
    return jsonRes({ error: msg }, status || 400);
  }

  function getToken(init) {
    var headers = (init && init.headers) || {};
    var auth = '';
    if (typeof headers.get === 'function') {
      auth = headers.get('authorization') || headers.get('Authorization') || '';
    } else {
      auth = headers['Authorization'] || headers['authorization'] || '';
    }
    return auth.replace(/^Bearer\s+/i, '') || localStorage.getItem('sf_token') || '';
  }

  function parseBody(init) {
    try { return JSON.parse((init && init.body) || '{}'); } catch (e) { return {}; }
  }

  // Detect "function does not exist" RPC mismatch errors from Supabase/PostgREST
  function isRpcSchemaMismatch(err) {
    if (!err || !err.message) return false;
    var msg = err.message.toLowerCase();
    return (
      msg.indexOf('could not find the function') !== -1 ||
      msg.indexOf('function') !== -1 && msg.indexOf('does not exist') !== -1 ||
      msg.indexOf('wrong number of arguments') !== -1 ||
      msg.indexOf('pgrst202') !== -1
    );
  }

  // ─── route handlers ──────────────────────────────────────────────────────────

  async function handleLogin(body) {
    var res = await db.rpc('sf_login', {
      p_name:      (body.name || '').trim(),
      p_password:  body.password || '',
      p_device_id: body.deviceId || ''
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 400);

    // Save credentials for device-ID auto-login overlay
    if (res.data && !res.data.error) {
      try {
        localStorage.setItem('sf_saved_creds', JSON.stringify({
          name:     (body.name || '').trim(),
          password: body.password || '',
          deviceId: body.deviceId || ''
        }));
      } catch (e) {}
    }
    return jsonRes(res.data);
  }

  async function handleRecover(body) {
    var recoveryCode = String(body.recoveryCode || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(recoveryCode)) {
      return jsonRes({
        error: 'Recovery Code must contain exactly 10 digits.'
      }, 400);
    }
    var res = await db.rpc('sf_recover', {
      p_recovery_code: recoveryCode,
      p_device_id:     body.deviceId    || ''
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 400);
    return jsonRes(res.data);
  }

  async function handleGetUser(userId, init) {
    var token = getToken(init);
    var res = await db.rpc('sf_get_user', {
      p_user_id: userId,
      p_token:   token
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 401);

    // Guarantee numeric stats — prevents NaN in the bundle's referral math
    var d = res.data || {};
    d.totalOrders      = parseInt(d.totalOrders,      10) || 0;
    d.successfulOrders = parseInt(d.successfulOrders, 10) || 0;
    d.referrals        = parseInt(d.referrals,        10) || 0;
    d.newCompleted     = Array.isArray(d.newCompleted) ? d.newCompleted : [];
    return jsonRes(d);
  }

  async function handleAddCoins(body, init) {
    var token = getToken(init);
    var res = await db.rpc('sf_add_coins', {
      p_token:  token,
      p_amount: parseInt(body.amount, 10) || 0
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 400);
    return jsonRes(res.data);
  }

  async function handlePlaceOrder(body, init) {
    var token        = getToken(init);
    var serviceIndex = parseInt(body.serviceIndex, 10);
    var instagramUrl = body.instagramUrl || '';
    var quantity     = parseInt(body.quantity, 10) || 0;

    // ── Step 1: Deduct coins & record order in Supabase FIRST ───────────
    // This is the source of truth — coins are only spent once the DB row
    // exists.  SMM placement happens afterwards (best-effort).
    var res = await db.rpc('sf_place_order', {
      p_token:             token,
      p_service_index:     serviceIndex,
      p_instagram_url:     instagramUrl,
      p_quantity:          quantity,
      p_external_order_id: ''
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 400);

    var orderData = res.data;            // contains orderId, newCoins, etc.
    var orderId   = orderData.orderId;

    // ── Step 2: Fetch service config & call SMM Panel (best-effort) ─────
    // Failure here (CORS, network, panel reject) is silently swallowed —
    // the order is already saved and will be processed manually if needed.
    if (orderId) {
      (async function () {
        try {
          var cfgRes = await db
            .from('services_config')
            .select('api_url, api_key, service_id')
            .eq('service_index', serviceIndex)
            .single();

          var cfg = (cfgRes.data) || {};
          if (!cfg.api_url || !cfg.api_key || !cfg.service_id) return;

          var smmParams = [
            'key='      + encodeURIComponent(cfg.api_key),
            'action=add',
            'service='  + encodeURIComponent(cfg.service_id),
            'link='     + encodeURIComponent(instagramUrl),
            'quantity=' + encodeURIComponent(String(quantity))
          ].join('&');

          var smmRes = await _realFetch(cfg.api_url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    smmParams
          });

          var smmData;
          try { smmData = await smmRes.json(); } catch (_) { smmData = {}; }

          if (smmData && smmData.order) {
            // Store the external order ID so refill can reference it later
            await db.rpc('sf_set_external_order_id', {
              p_token:             token,
              p_order_id:          orderId,
              p_external_order_id: String(smmData.order)
            });
          }
        } catch (_) {
          // Silently ignore — order is already saved in Supabase
        }
      })();
    }

    // Return success immediately after Supabase write — don't wait for SMM
    return jsonRes(orderData, 201);
  }

  async function handleGetOrders(init) {
    var token = getToken(init);
    // Use SECURITY DEFINER RPC — direct anon reads on `sessions` are
    // blocked by RLS (no anon policy exists on that table).
    var res = await db.rpc('sf_get_orders', { p_token: token });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 401);

    var now           = Date.now();
    var MS_PER_DAY    = 24 * 60 * 60 * 1000;
    var WINDOW_MS     = 90 * MS_PER_DAY;

    // Attach serviceName + refill metadata, then sort guarantee orders first
    var rows = (Array.isArray(res.data) ? res.data : []).map(function (o) {
      var guarantee    = isGuaranteeService(o.serviceIndex);
      var ageMs        = now - new Date(o.createdAt).getTime();
      var withinWindow = ageMs < WINDOW_MS;
      var notRefilling = (o.status !== 'Refilling');
      var daysRemaining = guarantee && withinWindow
        ? Math.max(0, Math.ceil((WINDOW_MS - ageMs) / MS_PER_DAY))
        : 0;

      return Object.assign({}, o, {
        serviceName:      getServiceName(o.serviceIndex),
        // Eligible if: guarantee service + within 90-day window + not already Refilling
        // (external_order_id not required — orders without one are processed manually)
        isRefillEligible: guarantee && withinWindow && notRefilling,
        refillDeadline:   guarantee
          ? new Date(new Date(o.createdAt).getTime() + WINDOW_MS).toISOString()
          : null,
        daysRemaining:    daysRemaining
      });
    });

    // Guarantee orders (index 0 & 2) appear at the top, then by date descending
    rows.sort(function (a, b) {
      var aG = isGuaranteeService(a.serviceIndex) ? 0 : 1;
      var bG = isGuaranteeService(b.serviceIndex) ? 0 : 1;
      if (aG !== bG) return aG - bG;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return jsonRes(rows);
  }

  async function handleSyncOrderStatus(orderId, init) {
    var token = getToken(init);

    // Fetch the order from DB first
    var orderRes = await db.rpc('sf_get_order', {
      p_token:    token,
      p_order_id: orderId
    });
    if (orderRes.error) return errRes(orderRes.error.message, 500);
    if (orderRes.data && orderRes.data.error) return jsonRes(orderRes.data, 404);

    var order = orderRes.data;
    if (!order.externalOrderId) {
      return jsonRes({ ok: true, status: order.status, updated: false, message: 'No external order ID — cannot sync' });
    }

    // Fetch service config for API credentials
    var cfgRes = await db
      .from('services_config')
      .select('api_url, api_key')
      .eq('service_index', order.serviceIndex)
      .single();

    var cfg = cfgRes.data || {};
    if (!cfg.api_url || !cfg.api_key) {
      return jsonRes({ ok: true, status: order.status, updated: false, message: 'SMM panel not configured' });
    }

    // Call SMM panel for live status
    try {
      var statusParams = [
        'key='   + encodeURIComponent(cfg.api_key),
        'action=status',
        'order=' + encodeURIComponent(order.externalOrderId)
      ].join('&');

      var smmRes = await _realFetch(cfg.api_url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    statusParams
      });

      var smmData;
      try { smmData = await smmRes.json(); } catch (_) { smmData = {}; }

      var rawStatus = (smmData && smmData.status) ? smmData.status.trim() : '';
      if (!rawStatus || rawStatus === order.status) {
        return jsonRes({ ok: true, status: order.status, updated: false, message: 'Status unchanged' });
      }

      // Normalise: title-case the raw status string
      var newStatus = rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1);

      // Persist updated status in Supabase
      await db.rpc('sf_update_order_status', {
        p_token:    token,
        p_order_id: orderId,
        p_status:   newStatus
      });

      return jsonRes({ ok: true, status: newStatus, updated: true, message: 'Status synced from SMM panel' });
    } catch (e) {
      // CORS or network error — return current DB status without failing
      return jsonRes({ ok: true, status: order.status, updated: false, message: 'SMM panel unreachable — showing saved status' });
    }
  }

  async function handleGetOrder(orderId, init) {
    var token = getToken(init);
    // Use SECURITY DEFINER RPC for same reason as handleGetOrders.
    // NOTE: The bundle calls /api/orders/:userId (userId = UUID) for the history
    // list. If that UUID doesn't match any orderId, fall back to the full list.
    var res = await db.rpc('sf_get_order', {
      p_token:    token,
      p_order_id: orderId
    });

    // Supabase-level error (e.g. invalid UUID cast) — likely a userId, return list
    if (res.error) return handleGetOrders(init);
    // Logical "not found" — same fallback
    if (res.data && res.data.error === 'Order not found') return handleGetOrders(init);
    if (res.data && res.data.error) return jsonRes(res.data, 404);

    var o             = res.data;
    var guarantee     = isGuaranteeService(o.serviceIndex);
    var MS_PER_DAY    = 24 * 60 * 60 * 1000;
    var WINDOW_MS     = 90 * MS_PER_DAY;
    var ageMs         = Date.now() - new Date(o.createdAt).getTime();
    var withinWindow  = ageMs < WINDOW_MS;
    var daysRemaining = guarantee && withinWindow
      ? Math.max(0, Math.ceil((WINDOW_MS - ageMs) / MS_PER_DAY))
      : 0;
    return jsonRes(Object.assign({}, o, {
      serviceName:      getServiceName(o.serviceIndex),
      isRefillEligible: guarantee && withinWindow && o.status !== 'Refilling',
      refillDeadline:   guarantee
        ? new Date(new Date(o.createdAt).getTime() + WINDOW_MS).toISOString()
        : null,
      daysRemaining:    daysRemaining
    }));
  }

  async function handleRefillOrder(orderId, init) {
    var token = getToken(init);

    // ── Step 1: Load & validate the target order ─────────────────────────
    var orderRes = await db.rpc('sf_get_order', {
      p_token:    token,
      p_order_id: orderId
    });
    if (orderRes.error) return errRes(orderRes.error.message, 500);
    if (orderRes.data && orderRes.data.error) return jsonRes(orderRes.data, 404);

    var order = orderRes.data;

    if (!isGuaranteeService(order.serviceIndex)) {
      return errRes('Refill is only available for 90 Days Guarantee services', 400);
    }

    var ageMs   = Date.now() - new Date(order.createdAt).getTime();
    var ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > 90) {
      return errRes('Refill period has expired (90-day window closed)', 400);
    }

    // ── Step 2: Fetch ALL eligible orders for the same link (bulk refill) ─
    // Use the SECURITY DEFINER RPC that bypasses RLS on the orders table.
    var bulkRes = await db.rpc('sf_get_refill_candidates', {
      p_token:         token,
      p_instagram_url: order.instagramUrl
    });
    if (bulkRes.error) return errRes(bulkRes.error.message, 500);

    var candidates = Array.isArray(bulkRes.data) ? bulkRes.data : [];
    if (candidates.length === 0) {
      return jsonRes({ ok: true, refilled: 0, message: 'No eligible orders found to refill' });
    }

    // ── Step 3: Fetch SMM API config for this service ─────────────────────
    var cfgRes = await db
      .from('services_config')
      .select('api_url, api_key')
      .eq('service_index', order.serviceIndex)
      .single();

    var cfg = cfgRes.data || {};

    // ── Step 4: Call SMM refill API for each candidate ────────────────────
    var succeeded = [];
    var failed    = [];

    for (var i = 0; i < candidates.length; i++) {
      var c      = candidates[i];
      var apiOk  = false;

      if (cfg.api_url && cfg.api_key && c.externalOrderId) {
        try {
          var refillParams = [
            'key='    + encodeURIComponent(cfg.api_key),
            'action=refill',
            'order='  + encodeURIComponent(c.externalOrderId)
          ].join('&');

          var rfRes  = await _realFetch(cfg.api_url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    refillParams
          });
          var rfData;
          try { rfData = await rfRes.json(); } catch (_) { rfData = {}; }
          // Accept if panel returns a refill ID or no error
          apiOk = !!(rfData && (rfData.refill || rfData.order || !rfData.error));
        } catch (_) { apiOk = false; }
      } else {
        // No SMM config yet — mark as Refilling for manual processing
        apiOk = true;
      }

      if (apiOk) {
        // Update order status in Supabase
        await db.rpc('sf_refill_order', { p_token: token, p_order_id: c.orderId });
        succeeded.push(c.orderId);
      } else {
        failed.push(c.orderId);
      }
    }

    var successMsg = succeeded.length > 0
      ? succeeded.length + ' order(s) submitted for refill! Check back in a few hours.'
      : 'No orders could be refilled at this time.';

    return jsonRes({
      ok:        true,
      attempted: candidates.length,
      succeeded: succeeded.length,
      failed:    failed.length,
      message:   successMsg
    });
  }

  async function handleGetServices(init) {
    // Run all DB reads in parallel for speed.
    // ─────────────────────────────────────────────────────────────────────────
    // BUG FIX: The anon RLS policy ('public_read_offerwall') only permits
    // SELECT on key='offerwall_url'. A direct table query for cpa_lead_url
    // and tutorial_video_url therefore returns 0 rows for those keys, causing
    // Choice 2 and the Tutorial Video to never appear on the Earn page.
    //
    // Fix: also call sf_get_public_config (SECURITY DEFINER — runs as postgres,
    // bypasses RLS entirely). Its result takes precedence over the direct query.
    // Falls back gracefully on old DBs that have not yet run the migration.
    // ─────────────────────────────────────────────────────────────────────────
    var results = await Promise.all([
      db.from('services_config')
        .select('service_index, api_url, coin_cost')
        .order('service_index'),
      db.from('app_config')
        .select('key, value')
        .in('key', ['offerwall_url', 'cpa_lead_url', 'tutorial_video_url']),
      db.rpc('sf_get_public_config')   // SECURITY DEFINER RPC — bypasses RLS
    ]);

    var svcRes = results[0];
    var cfgRes = results[1];
    var pubRes = results[2];   // May fail on old DBs (handled gracefully below)

    if (svcRes.error) return errRes(svcRes.error.message, 500);

    // Direct table query (anon RLS only reliably returns offerwall_url)
    var cfgMap = {};
    ((cfgRes.data) || []).forEach(function(row) { cfgMap[row.key] = row.value || ''; });
    var offerwallUrl = cfgMap['offerwall_url']      || '';
    var cpaLeadUrl   = cfgMap['cpa_lead_url']       || '';
    var videoUrl     = cfgMap['tutorial_video_url'] || '';

    // Override with RPC values when available — RPC bypasses RLS so it always
    // returns the correct values for cpa_lead_url and tutorial_video_url.
    if (pubRes && !pubRes.error && pubRes.data) {
      if (pubRes.data.offerwallUrl) offerwallUrl = pubRes.data.offerwallUrl;
      if (pubRes.data.cpaLeadUrl)   cpaLeadUrl   = pubRes.data.cpaLeadUrl;
      if (pubRes.data.videoUrl)     videoUrl     = pubRes.data.videoUrl;
    }

    // ── Server-side user UUID substitution ─────────────────────────────────
    // supabase-api.js runs in the browser so localStorage is fully accessible.
    // sf_user_id is written by Pv(A.userId) at login time — it is always the
    // UUID returned by sf_login ('userId': v_user.id). Reading it directly here
    // is simpler and more reliable than a sessions table query (which is blocked
    // by RLS when using the anon key).
    if (offerwallUrl) {
      // Primary source: sf_user_id set at login (the Supabase users.id UUID)
      var realUid = localStorage.getItem('sf_user_id') || '';

      // Secondary: parse it out of the session token claim if localStorage is empty
      if (!realUid) {
        var token = getToken(init);
        if (token) {
          try {
            // sf_token is a UUID stored in the sessions table — use an RPC that
            // runs as SECURITY DEFINER and bypasses RLS entirely
            var sessRpc = await db.rpc('sf_get_user_id_from_token', { p_token: token });
            if (sessRpc.data) realUid = sessRpc.data;
          } catch (e) {}
        }
      }

      if (realUid) {
        // Replace every known placeholder variant with the real UUID.
        // The bundle's own client-side .replace("{userid}", n) then finds no
        // placeholder left — it becomes a harmless no-op.
        offerwallUrl = offerwallUrl
          .replace(/\{user_id\}/gi,    realUid)
          .replace(/\{userid\}/gi,     realUid)
          .replace(/%7Buser_id%7D/gi,  realUid)
          .replace(/%7Buserid%7D/gi,   realUid)
          .replace(/\[user_id\]/gi,    realUid)
          .replace(/\[userid\]/gi,     realUid);

        // ── TimeWall: ensure &subid=USER_UUID is always present ────────
        // TimeWall uses ?subid= to identify the user in postbacks.
        // If the stored URL does not already carry a real subid value,
        // append (or replace) it with the logged-in user's UUID so
        // "Invalid External UserId" errors are eliminated.
        try {
          var _twParsed = new URL(offerwallUrl);
          var _twSubid  = _twParsed.searchParams.get('subid') || '';
          // Replace if missing, empty, or still a placeholder string
          if (!_twSubid || /^\{.*\}$/.test(_twSubid) || /^\[.*\]$/.test(_twSubid)) {
            _twParsed.searchParams.set('subid', realUid);
            offerwallUrl = _twParsed.toString();
          }
        } catch (_twErr) {
          // URL parse failed (relative URL?) — fall back to string append
          if (offerwallUrl.indexOf('subid=') === -1) {
            offerwallUrl += (offerwallUrl.indexOf('?') === -1 ? '?' : '&') + 'subid=' + encodeURIComponent(realUid);
          }
        }
      } else {
        // Not logged in yet — normalise to {userid} so the bundle's own
        // substitution can handle it when the user does log in.
        offerwallUrl = offerwallUrl
          .replace(/\{user_id\}/g,    '{userid}')
          .replace(/%7Buser_id%7D/gi, '{userid}')
          .replace(/\[user_id\]/gi,   '{userid}')
          .replace(/\{USERID\}/g,     '{userid}')
          .replace(/\{USER_ID\}/g,    '{userid}');
      }
    }

    var services = (svcRes.data || []).map(function (s) {
      var configured = !!(s.api_url && s.api_url.trim() !== '' && s.coin_cost > 0);
      return {
        serviceIndex: s.service_index,
        coinCost:     s.coin_cost,
        isAvailable:  configured
      };
    });

    // Apply same user-id substitution to cpaLeadUrl
    if (cpaLeadUrl) {
      var _realUid2 = localStorage.getItem('sf_user_id') || '';
      if (_realUid2) {
        cpaLeadUrl = cpaLeadUrl
          .replace(/\{user_id\}/gi,    _realUid2)
          .replace(/\{userid\}/gi,     _realUid2)
          .replace(/%7Buser_id%7D/gi,  _realUid2)
          .replace(/%7Buserid%7D/gi,   _realUid2)
          .replace(/\[user_id\]/gi,    _realUid2)
          .replace(/\[userid\]/gi,     _realUid2);
        try {
          var _cpParsed = new URL(cpaLeadUrl);
          var _cpSubid  = _cpParsed.searchParams.get('subid') || '';
          if (!_cpSubid || /^\{.*\}$/.test(_cpSubid) || /^\[.*\]$/.test(_cpSubid)) {
            _cpParsed.searchParams.set('subid', _realUid2);
            cpaLeadUrl = _cpParsed.toString();
          }
        } catch (_cpErr) {
          if (cpaLeadUrl.indexOf('subid=') === -1) {
            cpaLeadUrl += (cpaLeadUrl.indexOf('?') === -1 ? '?' : '&') + 'subid=' + encodeURIComponent(_realUid2);
          }
        }
      }
    }

    // Cache globally so index.html patches can reference them without re-fetching
    try { window.__sfVideoUrl = videoUrl; window.__sfCpaLeadUrl = cpaLeadUrl; } catch (_) {}

    return jsonRes({ services: services, offerwallUrl: offerwallUrl, cpaLeadUrl: cpaLeadUrl, videoUrl: videoUrl });
  }

  async function handleApplyReferral(body, init) {
    var token = getToken(init);
    var res = await db.rpc('sf_apply_referral', {
      p_token:         token,
      p_referral_code: body.referralCode || body.code || ''
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 400);
    return jsonRes(res.data);
  }

  async function handleAdminVerify(body) {
    var res = await db.rpc('sf_verify_admin', { p_passcode: body.passcode || '' });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 401);
    return jsonRes(res.data);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Admin: Get Config
  // Enhanced with fallback: if the RPC omits cpaLeadUrl / videoUrl (old DB
  // schema), we directly query app_config (anon key has SELECT on this table).
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleAdminGetConfig(init) {
    var token = getToken(init);
    var res = await db.rpc('sf_admin_get_config', { p_admin_token: token });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 401);

    var cfg = Object.assign({}, res.data || {});

    // ── Fallback: if the RPC returned without cpaLeadUrl / videoUrl
    //    (old DB function), directly read the app_config rows.
    //    The anon key has SELECT on app_config (same path used by handleGetServices).
    var needsFallback = (cfg.cpaLeadUrl === undefined || cfg.cpaLeadUrl === null ||
                         cfg.videoUrl   === undefined || cfg.videoUrl   === null);
    if (needsFallback) {
      try {
        var fbRes = await db
          .from('app_config')
          .select('key, value')
          .in('key', ['cpa_lead_url', 'tutorial_video_url']);
        var rows = (fbRes.data || []);
        rows.forEach(function (row) {
          if (row.key === 'cpa_lead_url'       && (cfg.cpaLeadUrl === undefined || cfg.cpaLeadUrl === null)) {
            cfg.cpaLeadUrl = row.value || '';
          }
          if (row.key === 'tutorial_video_url' && (cfg.videoUrl   === undefined || cfg.videoUrl   === null)) {
            cfg.videoUrl = row.value || '';
          }
        });
      } catch (fbErr) {
        // Non-fatal — leave the field as empty string
        if (cfg.cpaLeadUrl === undefined || cfg.cpaLeadUrl === null) cfg.cpaLeadUrl = '';
        if (cfg.videoUrl   === undefined || cfg.videoUrl   === null) cfg.videoUrl   = '';
      }
    }

    // Guarantee the fields exist (even if empty) so React state initialises correctly
    if (!cfg.cpaLeadUrl) cfg.cpaLeadUrl = '';
    if (!cfg.videoUrl)   cfg.videoUrl   = '';

    return jsonRes(cfg);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Admin: Save Config
  // Robust multi-strategy save so cpaLeadUrl / videoUrl are never silently lost:
  //
  //  Strategy A (preferred): call the 4-param RPC (new schema).
  //  Strategy B (fallback):  if the DB still has the old 2-param RPC, call it
  //    for offerwallUrl, then call a lightweight dedicated RPC for the two new
  //    fields (sf_admin_save_extra_config, added in migration-cpalead-video.sql).
  //  Strategy C (last resort): if neither extra RPC exists, save the new fields
  //    via sf_admin_save_config_v3 which we provide in the migration file.
  //
  // In all cases the caller gets a valid JSON response; a '_warning' key is
  // included when a downgraded save path was taken so the UI can surface it.
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleAdminSaveConfig(body, init) {
    var token         = getToken(init);
    var offerwallUrl  = body.offerwallUrl  || '';
    var cpaLeadUrl    = body.cpaLeadUrl    || '';
    var videoUrl      = body.videoUrl      || '';

    // ── Strategy A: 4-param RPC (schema.sql current version) ─────────────
    var res = await db.rpc('sf_admin_save_config', {
      p_admin_token:    token,
      p_offerwall_url:  offerwallUrl,
      p_cpa_lead_url:   cpaLeadUrl,
      p_video_url:      videoUrl
    });

    // If Strategy A succeeded — done.
    if (!res.error) {
      if (res.data && res.data.error) return jsonRes(res.data, 401);
      return jsonRes(res.data);
    }

    // ── Strategy A failed — check if it is a schema mismatch ─────────────
    if (!isRpcSchemaMismatch(res.error)) {
      // A real error (auth, DB down, etc.) — report it
      return errRes(res.error.message, 500);
    }

    // ── Strategy B: old 2-param RPC + sf_admin_save_extra_config ─────────
    var resOld = await db.rpc('sf_admin_save_config', {
      p_admin_token:   token,
      p_offerwall_url: offerwallUrl
    });
    if (resOld.error && !isRpcSchemaMismatch(resOld.error)) {
      return errRes(resOld.error.message, 500);
    }
    if (resOld.data && resOld.data.error) return jsonRes(resOld.data, 401);

    // Try the extra-config RPC (added by migration-cpalead-video.sql)
    var resExtra = await db.rpc('sf_admin_save_extra_config', {
      p_admin_token:  token,
      p_cpa_lead_url: cpaLeadUrl,
      p_video_url:    videoUrl
    });

    if (!resExtra.error) {
      // Strategy B fully succeeded
      if (resExtra.data && resExtra.data.error) return jsonRes(resExtra.data, 401);
      return jsonRes(Object.assign({}, resOld.data || {}, { ok: true }));
    }

    // ── Strategy C: fallback succeeded partially ─────────────────────────
    // offerwallUrl was saved; cpaLeadUrl & videoUrl could not be saved because
    // the DB migration has not been run yet. Return success with a warning.
    return jsonRes({
      ok: true,
      _warning: 'DB schema outdated: Choice 2 URL and Tutorial Video URL were NOT saved. ' +
                'Please run migration-cpalead-video.sql in your Supabase SQL Editor to enable these fields.'
    });
  }

  async function handleAdminSaveService(idx, body, init) {
    var token = getToken(init);
    var res = await db.rpc('sf_admin_save_service', {
      p_admin_token:   token,
      p_service_index: parseInt(idx, 10),
      p_api_url:       body.apiUrl    || '',
      p_api_key:       body.apiKey    || '',
      p_service_id:    body.serviceId || '',
      p_coin_cost:     parseInt(body.coinCost, 10) || 0
    });
    if (res.error) return errRes(res.error.message, 500);
    if (res.data && res.data.error) return jsonRes(res.data, 401);
    return jsonRes(res.data);
  }

  // ─── router ──────────────────────────────────────────────────────────────────

  async function route(url, init) {
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body   = (method !== 'GET') ? parseBody(init) : {};

    // Auth
    if (url === '/api/auth/login'   && method === 'POST') return handleLogin(body);
    if (url === '/api/auth/recover' && method === 'POST') return handleRecover(body);

    // User
    var userM = url.match(/^\/api\/user\/([^/]+)$/);
    if (userM && method === 'GET') return handleGetUser(userM[1], init);

    // Coins
    if (url === '/api/coins/add' && method === 'POST') return handleAddCoins(body, init);

    // Orders
    if (url === '/api/orders' && method === 'POST') return handlePlaceOrder(body, init);
    if (url === '/api/orders' && method === 'GET')  return handleGetOrders(init);

    var orderM = url.match(/^\/api\/orders\/([^/]+)$/);
    if (orderM && method === 'GET')  return handleGetOrder(orderM[1], init);

    var refillM = url.match(/^\/api\/orders\/([^/]+)\/refill$/);
    if (refillM && method === 'POST') return handleRefillOrder(refillM[1], init);

    var syncM = url.match(/^\/api\/orders\/([^/]+)\/sync$/);
    if (syncM && method === 'POST') return handleSyncOrderStatus(syncM[1], init);

    // Services (public — but we read the session token to substitute the real user UUID)
    if (url === '/api/services' && method === 'GET') return handleGetServices(init);

    // Referral
    if (url === '/api/referral/apply' && method === 'POST') return handleApplyReferral(body, init);

    // Admin
    if (url === '/api/admin/verify' && method === 'POST') return handleAdminVerify(body);
    if (url === '/api/admin/config' && method === 'GET')  return handleAdminGetConfig(init);
    if (url === '/api/admin/config' && method === 'POST') return handleAdminSaveConfig(body, init);

    var svcM = url.match(/^\/api\/admin\/services\/(\d+)$/);
    if (svcM && method === 'POST') return handleAdminSaveService(svcM[1], body, init);

    // Fallback — should not happen
    return errRes('Not found', 404);
  }

  // ─── fetch override ──────────────────────────────────────────────────────────

  var _realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');

    if (url.startsWith('/api/')) {
      try {
        return await route(url, init);
      } catch (err) {
        console.error('[StarFollower API]', err);
        return errRes('Internal error: ' + err.message, 500);
      }
    }

    return _realFetch(input, init);
  };

  console.log('[Star Follower] Supabase API layer v2.1 loaded ✓');
})();
