/* ══════════════════════════════════════════════════════════════
   supabase.js — Client/data layer + authentication
   ──────────────────────────────────────────────────────────────
   Loaded AFTER navigation.js and BEFORE supabase-api.js so the
   offline-first fetch wrapper sits underneath every later wrapper.

   Responsibilities:
     1. Persistent API response cache (offline-first first paint)
     2. View cache used by the bundle's query hooks
     3. Sequential API request queue + 15s watchdog on every fetch
     4. Auth bootstrap: cached session, background session recovery
     5. Device-ID 1-click auto-login banner
   ══════════════════════════════════════════════════════════════ */
(function (window, document) {
  'use strict';

        var CACHE_KEY = 'sf_api_cache_v1';
        var VIEW_CACHE_KEY = 'sf_view_cache_v2';
        var CACHE_MAX_ENTRIES = 40;

        /* ── PERSISTENT API RESPONSE CACHE (offline-first render) ──────
           localStorage is SYNCHRONOUS. The previous version parsed and
           re-serialized the whole cache blob on EVERY fetch call, and a
           tab mount fires several calls at once — that main-thread cost
           is exactly what showed up as "tap a tab, screen freezes for a
           moment". Now the blob is parsed ONCE into memory and written
           back at most once per idle slice. */
        var _memStore = null;
        var _flushPending = false;

        function readCacheStore() {
          if (_memStore) return _memStore;
          try {
            var raw = window.localStorage.getItem(CACHE_KEY);
            _memStore = raw ? JSON.parse(raw) : {};
          } catch (e) {
            _memStore = {};
          }
          return _memStore;
        }

        function scheduleFlush() {
          if (_flushPending) return;
          _flushPending = true;
          idle(function () {
            _flushPending = false;
            var store = _memStore || {};
            try {
              var keys = Object.keys(store);
              if (keys.length > CACHE_MAX_ENTRIES) {
                keys.sort(function (a, b) { return (store[a].ts || 0) - (store[b].ts || 0); });
                while (keys.length > CACHE_MAX_ENTRIES) {
                  delete store[keys.shift()];
                }
              }
              window.localStorage.setItem(CACHE_KEY, JSON.stringify(store));
            } catch (e) {
              /* Quota or serialization issue — never let storage affect
                 the live response or the current frame. */
            }
          });
        }

        function cacheKey(url) { return 'GET ' + url; }

        function getCachedEntry(url) {
          var store = readCacheStore();
          return store[cacheKey(url)] || null;
        }

        /* ── VIEW CACHE (React Query hydration, read synchronously) ────
           Parsed once into memory, mirrored from API responses in idle
           time. window.__sfReadViewCache is what the patched query hooks
           in the app bundle call for their initialData, so the first
           paint of every tab has real data without any network wait. */
        var _viewStore = null;
        var _viewFlushPending = false;

        function readViewStore() {
          if (_viewStore) return _viewStore;
          try {
            var raw = window.localStorage.getItem(VIEW_CACHE_KEY);
            _viewStore = raw ? JSON.parse(raw) : {};
          } catch (e) {
            _viewStore = {};
          }
          return _viewStore;
        }

        function scheduleViewFlush() {
          if (_viewFlushPending) return;
          _viewFlushPending = true;
          idle(function () {
            _viewFlushPending = false;
            try {
              window.localStorage.setItem(VIEW_CACHE_KEY, JSON.stringify(_viewStore || {}));
            } catch (e) {}
          });
        }

        function apiPathOf(url) {
          var s = String(url || '');
          var idx = s.indexOf('/api/');
          if (idx === -1) return '';
          return s.slice(idx).split('?')[0];
        }

        function writeViewCache(url, bodyText) {
          var path = apiPathOf(url);
          if (!path) return;
          try {
            var data = JSON.parse(bodyText);
            var store = readViewStore();
            store[path] = { data: data, updatedAt: Date.now() };
            scheduleViewFlush();
          } catch (e) {}
        }

        window.__sfReadViewCache = function (path, fallback) {
          try {
            var entry = readViewStore()[String(path || '').split('?')[0]];
            if (entry && entry.data !== undefined && entry.data !== null) {
              return { data: entry.data, updatedAt: entry.updatedAt || 0 };
            }
          } catch (e) {}
          return { data: fallback, updatedAt: 0 };
        };

        /* Dedupe repeated credit-sync callbacks (WebViews fire them more
           than once). In-memory only — no storage on the hot path. */
        var _syncStamps = {};
        window.__sfCanSync = function (key, windowMs) {
          var now = Date.now();
          var last = _syncStamps[key] || 0;
          if (now - last < (windowMs || 15000)) return false;
          _syncStamps[key] = now;
          return true;
        };

        function setCachedEntry(url, entry) {
          var store = readCacheStore();
          entry.ts = Date.now();
          store[cacheKey(url)] = entry;
          scheduleFlush();
          writeViewCache(url, entry.body);
        }

        function buildResponseFromCache(entry) {
          var headers = new Headers(entry.headers || {});
          return new Response(entry.body, { status: entry.status || 200, headers: headers });
        }

        function isApiUrl(url) {
          if (!url) return false;
          return url.indexOf('/api/') !== -1 || url.indexOf('supabase.co') !== -1;
        }

        /* ── 4) SEQUENTIAL REQUEST QUEUE (no parallel bursts) ──────────
           Automatic/background GET calls to API endpoints are run one
           at a time (small cap, not unlimited-parallel) instead of all
           firing together the instant a screen mounts. User-initiated
           writes (login, place order, logout, etc.) skip the queue so
           they're never held up behind background polling. */
        var API_MAX_CONCURRENT = 2;
        var _apiQueue = [];
        var _apiActive = 0;

        function pumpApiQueue() {
          while (_apiActive < API_MAX_CONCURRENT && _apiQueue.length) {
            var job = _apiQueue.shift();
            _apiActive++;
            job.run().then(
              function (v) { _apiActive--; job.resolve(v); pumpApiQueue(); },
              function (e) { _apiActive--; job.reject(e); pumpApiQueue(); }
            );
          }
        }

        function enqueueApi(run) {
          return new Promise(function (resolve, reject) {
            _apiQueue.push({ run: run, resolve: resolve, reject: reject });
            pumpApiQueue();
          });
        }

        /* ── 5) FETCH WRAPPER: timeout + queue + offline-first cache ──
           Every fetch() is guaranteed to settle within FETCH_TIMEOUT_MS.
           This wrapper is installed first, so every later fetch wrapper
           in this app (supabase-api.js, the admin CPA-URL interceptor,
           etc.) sits on top of it and inherits this behavior.

           GET requests to API endpoints:
             - If a cached copy exists, it resolves IMMEDIATELY with the
               cached data (offline-first render — no waiting on the
               network at all for paint), and a real request is queued
               in the background to refresh the cache for next time.
             - If no cached copy exists yet (first-ever load), the real
               request is queued and awaited normally, then cached.

           Non-API requests (page assets, fonts, the app bundle itself)
           are never queued or cached here — they go straight through
           with just the timeout applied.

           IMPORTANT: the app's data layer (react-query) calls fetch
           with its OWN AbortSignal already attached (for cancelling on
           unmount / refetch). We always install our own controller and
           forward an abort from the caller's signal into it, so both
           can trigger an abort but our timeout always applies. */
        var FETCH_TIMEOUT_MS = 15000; // 15s network/auth window for Android WebViews
        var _nativeFetch = window.fetch ? window.fetch.bind(window) : null;

        function timedFetch(input, init, url) {
          var callerSignal = init.signal;
          var controller = new AbortController();
          var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
          var forwardCallerAbort = function () { controller.abort(); };

          if (callerSignal) {
            if (callerSignal.aborted) {
              controller.abort();
            } else {
              callerSignal.addEventListener('abort', forwardCallerAbort, { once: true });
            }
          }

          var finalInit = Object.assign({}, init, { signal: controller.signal });
          var settle = function () {
            clearTimeout(timer);
            if (callerSignal) {
              callerSignal.removeEventListener('abort', forwardCallerAbort);
            }
          };

          return _nativeFetch(input, finalInit).then(
            function (res) { settle(); return res; },
            function (err) {
              settle();
              var callerAborted = callerSignal && callerSignal.aborted;
              if (callerAborted) throw err; // real cancellation, propagate as-is
              if (err && err.name === 'AbortError') {
                var timeoutErr = new Error('Request timed out after ' + FETCH_TIMEOUT_MS + 'ms: ' + url);
                timeoutErr.name = 'TimeoutError';
                throw timeoutErr;
              }
              throw err;
            }
          );
        }

        if (_nativeFetch && typeof AbortController === 'function') {
          window.fetch = function (input, init) {
            init = init || {};
            var url = typeof input === 'string' ? input : ((input && input.url) || '');
            var method = (init.method || 'GET').toUpperCase();
            var api = isApiUrl(url);

            function realRequest() {
              return timedFetch(input, init, url).then(function (res) {
                if (api && method === 'GET' && res && res.ok) {
                  // Clone now (cheap), but read + store in idle time so
                  // serialization never lands inside a tap/paint frame.
                  try {
                    var _copy = res.clone();
                    idle(function () {
                      _copy.text().then(function (bodyText) {
                        var headerObj = {};
                        try { res.headers.forEach(function (v, k) { headerObj[k] = v; }); } catch (e) {}
                        setCachedEntry(url, { status: res.status, headers: headerObj, body: bodyText });
                      }).catch(function () {});
                    });
                  } catch (e) {}
                }
                return res;
              });
            }

            if (!api) {
              // Page assets / third-party calls: timeout only, no queue.
              return timedFetch(input, init, url);
            }

            if (method !== 'GET') {
              // Writes (login, place order, logout...) run immediately,
              // never blocked behind background polling.
              return timedFetch(input, init, url);
            }

            var cached = getCachedEntry(url);

            if (cached && !window.__sfApiRouteRevalidating) {
              // Offline-first: render instantly from cache, refresh
              // quietly in the background through the queue. Any
              // failure of the background refresh is swallowed — the
              // UI already has data on screen from the cache.
              // Background refresh is scheduled for idle time so it can
              // never compete with the render of the tab the user just
              // opened. The cached response resolves immediately.
              idle(function () { enqueueApi(realRequest).catch(function () {}); });
              return Promise.resolve(buildResponseFromCache(cached));
            }

            // No cache yet (first load of this endpoint): queue the
            // real request so it doesn't burst in parallel with
            // whatever else is loading right now, but still await it
            // normally since there's nothing to render in the meantime.
            return enqueueApi(realRequest);
          };
        }

        /* ── 6) SAFETY NET for anything that still slips through ───────
           If a fetch/storage-related promise rejects with nobody
           listening, swallow it quietly (console only) instead of
           letting the WebView's default unhandled-rejection behavior
           appear to "freeze" or crash the page. Nothing is shown to
           the end user. */
        window.addEventListener('unhandledrejection', function (event) {
          var reason = event && event.reason;
          var name = reason && reason.name;
          if (name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError') {
            console.warn('[sf-webview-compat] network call did not complete cleanly:', reason);
            event.preventDefault();
          }
        });

  /* ── 4) AUTH BOOTSTRAP ─────────────────────────────────────── */
  (function () {
        var AUTH_CACHE_KEY = 'sf_auth_session_v1';
        var SUPABASE_AUTH_KEY = 'sb-lgqovwlmicjinwrteivn-auth-token';

        function readJson(key) {
          try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
          } catch (e) {
            return null;
          }
        }

        // Synchronous auth snapshot: never await getSession for first paint.
        window.__sfCachedAuthSession =
          readJson(AUTH_CACHE_KEY) ||
          readJson(SUPABASE_AUTH_KEY) ||
          null;

        function cacheSession(session) {
          if (!session) return;
          try {
            localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(session));
          } catch (e) {}
          window.__sfCachedAuthSession = session;
        }

        function resolveSessionInBackground() {
          var client = window.__sfSupabaseClient;
          if (!client || !client.auth || typeof client.auth.getSession !== 'function') {
            return;
          }

          var timeoutId;
          var timeout = new Promise(function (_, reject) {
            timeoutId = setTimeout(function () {
              var error = new Error('Supabase auth session timed out after 10000ms');
              error.name = 'AuthSessionTimeoutError';
              reject(error);
            }, 10000);
          });
          var sessionPromise;
          try {
            sessionPromise = client.auth.getSession();
          } catch (e) {
            window.__sfAuthSessionReady = true;
            return;
          }

          Promise.race([Promise.resolve(sessionPromise), timeout])
            .then(function (result) {
              clearTimeout(timeoutId);
              var session = result && result.data && result.data.session;
              if (session) cacheSession(session);
              window.__sfAuthSessionReady = true;
              window.dispatchEvent(new CustomEvent('sf-auth-session-ready'));
            })
            .catch(function () {
              clearTimeout(timeoutId);
              // Cached auth remains authoritative for the first render.
              window.__sfAuthSessionReady = true;
            });
        }

        // Defer only the reconciliation, not the app mount.
        if (window.queueMicrotask) {
          queueMicrotask(resolveSessionInBackground);
        } else {
          setTimeout(resolveSessionInBackground, 0);
        }
  }());

  /* ── 5) DEVICE-ID AUTO-LOGIN BANNER ────────────────────────── */
  function initDeviceIdLogin() {
        var wrap    = document.getElementById('sf-dil-wrap');
        var sub     = document.getElementById('sf-dil-sub');
        var loginBt = document.getElementById('sf-dil-login-btn');
        var closeBt = document.getElementById('sf-dil-close-btn');
        var creds   = null;

        try { creds = JSON.parse(localStorage.getItem('sf_saved_creds') || 'null'); } catch (e) {}
        if (!creds || !creds.name || !creds.password) return;

        /* Show after React mounts, only when logged out */
        setTimeout(function () {
          if (sfLoggedIn()) return;
          sub.innerHTML =
            '<span style="color:#c9a84c;">👤</span> ' + creds.name +
            ' &nbsp;<span style="color:#c9a84c;">🔑</span> ' +
            creds.password.replace(/./g, '●');
          wrap.style.display = 'flex';
        }, 1400);

        closeBt.addEventListener('click', function (e) {
          e.stopPropagation();
          wrap.style.display = 'none';
        });

        loginBt.addEventListener('click', function () {
          loginBt.textContent = '...';
          loginBt.disabled    = true;

          fetch('/api/auth/login', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              name:     creds.name,
              password: creds.password,
              deviceId: localStorage.getItem('sf_device_id') || ''
            })
          })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.userId && d.token) {
              localStorage.setItem('sf_user_id', d.userId);
              localStorage.setItem('sf_token',   d.token);
              wrap.style.display = 'none';
              window.location.replace(window.__sfAppPath('/'));
            } else {
              loginBt.textContent = '1-click Login';
              loginBt.disabled    = false;
              sub.innerHTML += '<br><span style="color:#ef4444;font-size:10px;">Login failed — please tap again</span>';
            }
          })
          .catch(function () {
            loginBt.textContent = '1-click Login';
            loginBt.disabled    = false;
          });
        });
  }
  if (document.body) {
    initDeviceIdLogin();
  } else {
    document.addEventListener('DOMContentLoaded', initDeviceIdLogin, { once: true });
  }
}(window, document));
