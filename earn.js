/* ══════════════════════════════════════════════════════════════
   earn.js — TimeWall / offerwall launcher, bonuses, coin flow
   ──────────────────────────────────────────────────────────────
     1-4. Four offerwall interception layers (createElement,
          MutationObserver, click capture, window.open) so offerwalls
          open in Capacitor Browser instead of a blocked iframe
     5.   Return-route restore when the user comes back from an offer
     6.   Offerwall navigation interception only
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
       // Also cover a full WebView document restore after same-document
       // navigation to a task URL.
       window.setTimeout(restoreTimewallReturnRoute, 0);

      // ── Open TimeWall in the app's Browser/custom-tab surface ─────
      function openExternal(href) {
         saveTimewallReturnRoute();
        href = injectSubid(href);
        if (typeof window.__sfOpenInAppBrowser === 'function') {
          window.__sfOpenInAppBrowser(href);
        } else {
          // Never use window.open/location.assign here: both can escape the
          // wrapper. The Browser bridge is loaded before this module.
          console.warn('[Star Follower] In-app Browser bridge unavailable');
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
          openExternal(url);
          return null;
        }
        return _realOpen(url, target, features);
      };


  /*
   * Choice 1 and Choice 2 are rendered by the Earn route in the app bundle.
   * This module intentionally does not create cards or append nodes to the
   * document; doing that here makes Choice 2 appear on every route.
   */
}());
