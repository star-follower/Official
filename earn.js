/* ══════════════════════════════════════════════════════════════
   earn.js — TimeWall / offerwall launcher, bonuses, coin flow
   ──────────────────────────────────────────────────────────────
     1-4. Four offerwall interception layers (createElement,
          MutationObserver, click capture, window.open) so offerwalls
          open in Chrome Custom Tabs instead of a blocked iframe
     5.   Return-route restore when the user comes back from an offer
     6.   Choice 2 instant-coins card injection
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

      // ── Patterns that identify a TimeWall / offerwall URL ─────────
      var TW_PATTERNS = [
        'timewall.io', 'go.timewall', 'offers.timewall',
        'timewall', 'offerwall'
      ];

      function isOfferwallUrl(href) {
        if (!href || typeof href !== 'string') return false;
        var lower = href.toLowerCase();
        for (var i = 0; i < TW_PATTERNS.length; i++) {
          if (lower.indexOf(TW_PATTERNS[i]) !== -1) return true;
        }
        return false;
      }

      // ── Inject logged-in user UUID as &subid= ─────────────────────
      function injectSubid(href) {
        var uid = localStorage.getItem('sf_user_id') || '';
        if (!uid) return href;
        try {
          var u = new URL(href);
          var existing = u.searchParams.get('subid') || '';
          // Replace if absent or still a template placeholder
          if (!existing || /^\{.*\}$/.test(existing) || /^\[.*\]$/.test(existing)) {
            u.searchParams.set('subid', uid);
          }
          return u.toString();
        } catch (_) {
          if (href.indexOf('subid=') === -1) {
            return href + (href.indexOf('?') === -1 ? '?' : '&') +
                   'subid=' + encodeURIComponent(uid);
          }
          return href;
        }
      }

       var TIMEWALL_RETURN_ROUTE_KEY = 'sf_timewall_return_route';
       var TIMEWALL_PENDING_KEY = 'sf_timewall_pending';

       function getCurrentAppRoute() {
         var path = window.__sfRoutePath
           ? window.__sfRoutePath()
           : (window.location.pathname.replace(/\/+$/, '') || '/');
         var hash = window.location.hash || '';
         if (hash.toLowerCase().indexOf('earn') !== -1 || path === '/earn') return '/earn';
         // This bundle serves the dashboard at "/", while older builds used
         // "/dashboard". Normalize both to the route this app actually serves.
         return path === '/dashboard' ? '/' : path;
       }

       function saveTimewallReturnRoute() {
         try {
           sessionStorage.setItem(TIMEWALL_RETURN_ROUTE_KEY, getCurrentAppRoute());
           sessionStorage.setItem(TIMEWALL_PENDING_KEY, '1');
         } catch (_) {}
       }

       function restoreTimewallReturnRoute() {
         if (document.hidden) return;
         var route = '';
         try {
           route = sessionStorage.getItem(TIMEWALL_RETURN_ROUTE_KEY) || '';
         } catch (_) {}
         if (!route) return;

         var loggedIn = !!(
           localStorage.getItem('sf_user_id') &&
           localStorage.getItem('sf_token')
         );
         if (!loggedIn) {
           try {
             sessionStorage.removeItem(TIMEWALL_RETURN_ROUTE_KEY);
             sessionStorage.removeItem(TIMEWALL_PENDING_KEY);
           } catch (_) {}
           return;
         }

         var current = getCurrentAppRoute();
         var root = document.getElementById('root');
         var isBlank = !root || !root.children.length;
         try {
           sessionStorage.removeItem(TIMEWALL_RETURN_ROUTE_KEY);
           sessionStorage.removeItem(TIMEWALL_PENDING_KEY);
         } catch (_) {}

         // Replacing the same route is intentional when Chrome returns with
         // an empty React root; it remounts the app instead of leaving white.
         if (current !== route || isBlank) {
           window.location.replace(
             window.__sfAppPath ? window.__sfAppPath(route) : route
           );
         }
       }

       document.addEventListener('visibilitychange', function () {
         if (!document.hidden) window.setTimeout(restoreTimewallReturnRoute, 80);
       });
       window.addEventListener('focus', function () {
         window.setTimeout(restoreTimewallReturnRoute, 80);
       });

      // ── Open in Chrome Custom Tabs (Android) / new tab ────────────
      function openExternal(href) {
         saveTimewallReturnRoute();
        href = injectSubid(href);
        // window.open(_blank) → Chrome Custom Tabs on Android.
        // noopener prevents the child from accessing window.opener.
        var win = window.open(href, '_blank', 'noopener,noreferrer');
        if (!win) {
          // Pop-up blocked (desktop) → same-tab fallback
          window.location.href = href;
        }
      }

      // ── LAYER 1: patch document.createElement ─────────────────────
      // Intercept iframe elements before they are added to the DOM.
      // When React tries to create an offerwall iframe, we return a
      // throwaway <span> so nothing gets inserted, then open externally.
      var _realCreate = document.createElement.bind(document);
      document.createElement = function (tag) {
        var el = _realCreate.apply(document, arguments);
        if (typeof tag === 'string' && tag.toLowerCase() === 'iframe') {
          // Proxy the src setter so we catch the URL when React sets it
          var _srcVal = '';
          Object.defineProperty(el, 'src', {
            get: function () { return _srcVal; },
            set: function (val) {
              _srcVal = val;
              if (isOfferwallUrl(val)) {
                // Prevent actual load — clear the src and open externally
                setTimeout(function () { openExternal(val); }, 0);
                _srcVal = 'about:blank';
              }
            },
            configurable: true
          });
        }
        return el;
      };

      // ── LAYER 2: MutationObserver — catch any iframe React inserts ─
      // Belt-and-suspenders: if an offerwall iframe reaches the DOM
      // (e.g. React set src before our createElement patch ran),
      // remove it and open the URL externally.
      // Cheap record scan (tag check only, no querySelectorAll per
      // record) + one coalesced sweep after paint. Previously every
      // added node during a route render triggered a subtree query,
      // which is what made tab switches stutter.
      function sweepOfferwallIframes() {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          var ifr = iframes[i];
          var src = ifr.src || ifr.getAttribute('src') || '';
          if (isOfferwallUrl(src)) {
            if (ifr.parentNode) ifr.parentNode.removeChild(ifr);
            openExternal(src);
          }
        }
      }
      var _scheduleSweep = window.__sfCoalesce
        ? window.__sfCoalesce(sweepOfferwallIframes)
        : function () { setTimeout(sweepOfferwallIframes, 32); };

      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType === 1) { _scheduleSweep(); return; }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });

      // ── LAYER 3: click capture on <a> tags ────────────────────────
      document.addEventListener('click', function (e) {
        var el = e.target;
        while (el && el.tagName !== 'A') el = el.parentElement;
        if (!el) return;
        var href = el.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('javascript:')) return;
        if (!isOfferwallUrl(href)) return;
        e.preventDefault();
        e.stopPropagation();
        openExternal(href);
      }, true /* capture phase — runs before React bubble handlers */);

      // ── LAYER 4: patch window.open ────────────────────────────────
      // The compiled bundle may call window.open() directly.
      var _realOpen = window.open.bind(window);
      window.open = function (url, target, features) {
        if (typeof url === 'string' && isOfferwallUrl(url)) {
           saveTimewallReturnRoute();
          return _realOpen(injectSubid(url), '_blank', 'noopener,noreferrer');
        }
        return _realOpen(url, target, features);
      };


  /* ── 6) CHOICE 2 CARD INJECTION ────────────────────────────── */
  var _cachedCpaUrl = '';
      var _choice2Injected = false;

      function injectChoice2Card(cpaLeadUrl) {
        if (_choice2Injected || !cpaLeadUrl) return;

        var containers = document.querySelectorAll('[class*="flex"][class*="flex-col"]');
        var earnContainer = null;
        for (var ci = 0; ci < containers.length; ci++) {
          var ct = containers[ci];
          var ctext = ct.textContent || '';
          if ((ctext.indexOf('Choice 1') !== -1 || ctext.indexOf('Coins Earn') !== -1 ||
               ctext.indexOf('कॉइन') !== -1 || ctext.indexOf('Offers') !== -1) &&
              ctext.indexOf('Admin') === -1) {
            earnContainer = ct;
            break;
          }
        }
        if (!earnContainer) return;

        // Check if bundle already rendered Choice 2
        var allSpans = earnContainer.querySelectorAll('span, div');
        for (var si = 0; si < allSpans.length; si++) {
          if ((allSpans[si].textContent || '').indexOf('Choice 2') !== -1) {
            _choice2Injected = true;
            return; // already present
          }
        }
        if (document.getElementById('sf-earn-choice2-patch')) {
          _choice2Injected = true;
          return;
        }

        // Build the Choice 2 card (matches the bundle's visual style)
        var uid = localStorage.getItem('sf_user_id') || '';
        var fullUrl = uid
          ? cpaLeadUrl.replace(/\{userid\}/gi, uid).replace(/%7Buserid%7D/gi, uid)
          : cpaLeadUrl;

        var c2wrap = document.createElement('div');
        c2wrap.id        = 'sf-earn-choice2-patch';
        c2wrap.role      = 'button';
        c2wrap.tabIndex  = 0;
        c2wrap.style.cssText = [
          'background:linear-gradient(135deg,#001a0d 0%,#002a18 40%,#000a05 100%)',
          'box-shadow:0 0 18px 2px rgba(16,185,129,0.12),0 4px 20px rgba(0,0,0,0.5)',
          'border:2px solid rgba(16,185,129,0.5)',
          'border-radius:16px',
          'padding:20px',
          'display:flex',
          'flex-direction:column',
          'gap:12px',
          'cursor:pointer',
          'user-select:none',
          'flex-shrink:0'
        ].join(';');

        c2wrap.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
            '<span style="display:flex;align-items:center;gap:8px;font-size:21px;font-weight:800;color:#6ee7b7;font-family:Inter,sans-serif">&#9889; Choice 2</span>' +
            '<span style="background:linear-gradient(90deg,#10b981,#6ee7b7);color:#000;font-size:11px;font-weight:800;padding:4px 12px;border-radius:999px;white-space:nowrap;letter-spacing:0.03em;font-family:Inter,sans-serif">Instant Coins / &#2340;&#2369;&#2352;&#2306;&#2340; &#2325;&#2377;&#2311;&#2344;&#2381;&#2360;</span>' +
          '</div>' +
          '<p style="color:rgba(167,243,208,0.85);font-size:13px;line-height:1.5;font-family:Inter,sans-serif;margin:0">&#2340;&#2369;&#2352;&#2306;&#2340; coins &#2346;&#2366;&#2319;&#2306; \u2014 instant reward offers, quick &amp; easy</p>' +
          '<div style="background:linear-gradient(90deg,#10b981,#34d399);color:#000;font-weight:800;font-size:13px;text-align:center;padding:9px;border-radius:10px;letter-spacing:0.04em;font-family:Inter,sans-serif">&#2340;&#2369;&#2352;&#2306;&#2340; &#2358;&#2369;&#2352;&#2370; &#2325;&#2352;&#2375;&#2306; \u2192</div>';

        c2wrap.addEventListener('click', function () {
          window.open(fullUrl, '_blank', 'noopener,noreferrer');
        });
        c2wrap.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') window.open(fullUrl, '_blank', 'noopener,noreferrer');
        });

        earnContainer.appendChild(c2wrap);
        _choice2Injected = true;
      }

      // Poll to inject Choice 2 once data is available and Earn page is rendered
      var _earnPollTimer = setInterval(function () {
        if (document.hidden) return;
        if (!_cachedCpaUrl   && window.__sfCpaLeadUrl)  _cachedCpaUrl   = window.__sfCpaLeadUrl;

        if (_cachedCpaUrl)    injectChoice2Card(_cachedCpaUrl);

        if (_choice2Injected) clearInterval(_earnPollTimer);
      }, 800);
      setTimeout(function () { clearInterval(_earnPollTimer); }, 60000);
}());
