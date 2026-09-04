/* ══════════════════════════════════════════════════════════════
   navigation.js — Non-blocking tab-switching controller + app shell
   ──────────────────────────────────────────────────────────────
   Loaded FIRST (before supabase.js / supabase-api.js) because it
   installs the storage safety net, the history/locationchange
   wrapper and the shared requestAnimationFrame + idle scheduler
   that every other module coalesces its DOM work through.

   Responsibilities:
     1. Safe localStorage / sessionStorage
     2. Smooth hash navigation (pushState/replaceState -> locationchange)
     3. Shared rAF + idle scheduler (window.__sfIdle / __sfCoalesce)
     4. Base path + route helpers (__sfAppPath / __sfRoutePath)
     5. Instant boot shell frame (paints before React hydrates)
     6. Async app-bundle loader with hash-router / tab patches
     7. Header gear -> Settings modal, APK install banner
   ══════════════════════════════════════════════════════════════ */
(function (window, document) {
  'use strict';

        /* ── 1) SAFE localStorage / sessionStorage ────────────────────
           If real localStorage throws on a basic read/write/delete
           cycle (seen on some locked-down / privacy-hardened WebView
           builds and Android's partitioned storage), swap in an
           in-memory Storage-compatible polyfill so every later
           localStorage.getItem/setItem/removeItem call in this app
           keeps working without throwing or freezing the page.
           Data won't persist across app restarts in that fallback
           case, but the UI will render instead of hanging. */
        function makeMemoryStorage() {
          var store = {};
          return {
            getItem: function (k) {
              return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
            },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; },
            clear: function () { store = {}; },
            key: function (i) { return Object.keys(store)[i] || null; },
            get length() { return Object.keys(store).length; }
          };
        }

        function testStorage(storage) {
          var testKey = '__sf_storage_test__';
          storage.setItem(testKey, '1');
          var ok = storage.getItem(testKey) === '1';
          storage.removeItem(testKey);
          return ok;
        }

        try {
          if (!window.localStorage || !testStorage(window.localStorage)) {
            throw new Error('localStorage unusable');
          }
        } catch (e) {
          try {
            Object.defineProperty(window, 'localStorage', {
              value: makeMemoryStorage(),
              configurable: true,
              writable: false
            });
          } catch (e2) {
            /* Some WebViews make window.localStorage non-configurable
               even while it throws on use — nothing more we can do,
               but we at least don't crash trying. */
          }
        }

        /* sessionStorage gets the same treatment — used for the APK
           banner dismissal state and the TimeWall return-route keys. */
        try {
          if (!window.sessionStorage || !testStorage(window.sessionStorage)) {
            throw new Error('sessionStorage unusable');
          }
        } catch (e) {
          try {
            Object.defineProperty(window, 'sessionStorage', {
              value: makeMemoryStorage(),
              configurable: true,
              writable: false
            });
          } catch (e2) {}
        }

        /* ── 2) SMOOTH HASH NAVIGATION ──────────────────────────────
           The app bundle's router (patched further below, in the
           <script type="module"> loader) already navigates by calling
           history.pushState/replaceState directly against an internal
           location store — it does not reload the page or unmount
           #root on tab taps. This wrapper is purely additive belt-
           and-suspenders: it preserves native pushState/replaceState
           behavior exactly (same arguments, same `this`), and also
           dispatches a lightweight 'locationchange' event so nothing
           has to poll or fall back to a hashchange-triggered re-
           evaluation of the page to notice a route change. Wrapped in
           try/catch so a failure here can never block navigation. */
        try {
          var _origPushState = history.pushState.bind(history);
          var _origReplaceState = history.replaceState.bind(history);

          history.pushState = function () {
            var ret = _origPushState.apply(history, arguments);
            try { window.dispatchEvent(new Event('locationchange')); } catch (e) {}
            return ret;
          };
          history.replaceState = function () {
            var ret = _origReplaceState.apply(history, arguments);
            try { window.dispatchEvent(new Event('locationchange')); } catch (e) {}
            return ret;
          };
        } catch (e) {
          /* If history can't be patched on this WebView, navigation
             still works exactly as before — nothing else depends on
             the 'locationchange' event existing. */
        }

        /* ── SCHEDULER ────────────────────────────────────────────────
           One shared idle scheduler for every deferred/coalesced job in
           this page (cache flushes, MutationObserver reactions, DOM
           patches). Keeping this work OFF the tap -> paint path is what
           makes bottom-nav tab switches feel instant on Android 13+. */
        var idle = window.requestIdleCallback
          ? function (fn) { return window.requestIdleCallback(fn, { timeout: 400 }); }
          : function (fn) { return setTimeout(fn, 32); };
        var raf = window.requestAnimationFrame
          ? window.requestAnimationFrame.bind(window)
          : function (fn) { return setTimeout(fn, 16); };
        window.__sfIdle = idle;
        /* coalesce(fn) -> a function that runs fn at most once per frame,
           after paint. Use it for any DOM-observing callback. */
        window.__sfCoalesce = function (fn) {
          var queued = false;
          return function () {
            if (queued) return;
            queued = true;
            raf(function () { idle(function () { queued = false; try { fn(); } catch (e) {} }); });
          };
        };

  /* ── 4) BASE PATH + ROUTE HELPERS ──────────────────────────── */
      (function () {
        var path = window.location.pathname || '';
        window.__SF_BASE_PATH = /^\/Official(?:\/|$)/i.test(path)
          ? '/Official/'
          : '/';
        window.__SF_HASH_ROUTING = true;
        var baseTag = document.querySelector('base');
        if (baseTag) baseTag.setAttribute('href', window.__SF_BASE_PATH);
        window.__sfAppPath = function (route) {
          var base = window.__SF_BASE_PATH || '/';
          var clean = String(route || '/').replace(/^\/+/, '');
          return base + '#' + (clean ? '/' + clean : '/');
        };
        window.__sfRoutePath = function () {
          var hash = window.location.hash || '';
          if (/^#\/?/.test(hash) && hash.length > 1) {
            return ('/' + hash.slice(1).replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
          }
          var pathname = window.location.pathname || '/';
          var baseRoot = (window.__SF_BASE_PATH || '/').replace(/\/+$/, '');
          if (baseRoot && pathname.indexOf(baseRoot) === 0) {
            pathname = pathname.slice(baseRoot.length) || '/';
          }
          return pathname.replace(/\/+$/, '') || '/';
        };
      }());


  /* ── 5) INSTANT BOOT SHELL ─────────────────────────────────── */
  function paintBootShell() {
        try {
          var userId = localStorage.getItem('sf_user_id');
          var token = localStorage.getItem('sf_token');
          var hash = window.location.hash || '';
          var route = hash.replace(/^#\/?/, '').split('?')[0] || 'home';
          if (!userId || !token || route === 'login') return;

          var profile = {};
          var cache = JSON.parse(localStorage.getItem('sf_view_cache_v2') || '{}');
          var profileEntry = cache['/api/user/' + userId];
          if (profileEntry && profileEntry.data) profile = profileEntry.data;

          var labels = {
            home: 'VIP Lounge',
            services: 'Instagram Services',
            earn: 'Coins कमाएं',
            orders: 'Order History',
            referrals: 'Refer & Earn'
          };
          var title = labels[route] || labels.home;
          var coins = Number(profile.coins);
          var coinsText = isFinite(coins) ? String(coins) : '0';
          document.getElementById('root').innerHTML =
            '<div id="sf-boot-shell" aria-busy="true">' +
              '<header class="sf-boot-header"><strong>⭐ Star Follower</strong><span>🪙 ' + coinsText + '</span></header>' +
              '<main class="sf-boot-main"><h1>' + title + '</h1><div class="sf-boot-card"></div><div class="sf-boot-card"></div></main>' +
              '<nav class="sf-boot-nav" aria-label="App navigation"><span>Home</span><span>Services</span><span>Earn</span><span>Orders</span><span>Refer</span></nav>' +
            '</div>';
        } catch (e) {
          // The boot frame is best-effort; React remains the source of truth.
        }
  }
  if (document.getElementById('root')) {
    paintBootShell();
  } else {
    document.addEventListener('DOMContentLoaded', paintBootShell, { once: true });
  }

  /* ── 6) ASYNC APP BUNDLE LOADER (hash router + tab patches) ──
     Exposed so index.html only needs a 2-line module bootstrap.
     Every route swap runs through requestAnimationFrame/idle work
     (see __sfCoalesce above), so a tab tap paints immediately. */
  window.__sfLoadAppBundle = async function () {
      var sfBase = window.__SF_BASE_PATH || '/';
      var sfBundleUrl = sfBase + 'assets/index-B3WfkW1_.js';
      var sfBundle = await fetch(sfBundleUrl).then(function (response) {
        if (!response.ok) throw new Error('Unable to load app bundle');
        return response.text();
      });
      sfBundle = sfBundle
        .replace(
          'tC="".replace(/\/+$/,"");function lb(n){return tC+n}function qr(n,r){return fetch(lb(n),r)}',
          'tC=(window.__SF_BASE_PATH||"").replace(/\/+$/,"");function lb(n){return tC+n}function qr(n,r){return fetch(n,r)}'
        )
        .replace(
          'Ip=()=>location.pathname,$1=',
          'Ip=()=>{const n=location.hash.slice(1);if(n)return n.startsWith("/")?n:"/"+n;const p=location.pathname,b=(window.__SF_BASE_PATH||"/").replace(/\\/+$/,"");return b&&p.indexOf(b)===0?(p.slice(b.length)||"/"):p},$1='
        )
        .replace(
          'J1=(n,{replace:r=!1,state:i=null}={})=>history[r?mf:hf](i,"",n)',
          'J1=(n,{replace:r=!1,state:i=null}={})=>{const o=(window.__SF_BASE_PATH||"/").replace(/\\/+$/,""),e=n&&n.startsWith("/")?n:"/"+(n||"");history[r?mf:hf](i,"",o+"#"+e)}'
        )
        /*
         * ROOT-CAUSE FIX — bottom nav tabs not switching on newer Android:
         * The router's location getter/setter (Ip/J1, patched above) were
         * already switched to hash-based navigation, but the Link
         * component's `hrefs` formatter was still the untouched identity
         * function (`n=>n`). That meant every rendered <a href="/earn">
         * (etc.) carried a raw root-relative path instead of a same-page
         * hash URL. Clicks were still intercepted by the Link's onClick
         * handler in most cases, but that literal href is what the
         * browser/WebView falls back to for anything outside a clean
         * synchronous click — including the touch-to-click handling and
         * link pre-navigation checks that changed in newer Chromium-based
         * WebView releases (Android 13+). A WebView wrapper's navigation
         * policy can then silently swallow that fallback attempt at
         * "/earn" (wrong path — GitHub Pages serves this app under
         * /Official/, and it isn't a real page anyway), which is exactly
         * what "tapping the tab does nothing" looks like from the
         * outside. Making the href a real, safe, same-page hash URL
         * (e.g. "/Official/#/earn") means even a fallback/native
         * navigation just changes the URL fragment — never a real
         * top-level request, so it can't be blocked or misrouted on any
         * Android version.
         */
        .replace(
          'hrefs:n=>n,aroundNav:(n,r,i)=>n(r,i)}',
          'hrefs:n=>(window.__sfAppPath?window.__sfAppPath(n):n),aroundNav:(n,r,i)=>n(r,i)}'
        )
        /*
         * The imported bundle has no authored React source tree. Inject the
         * tutorial component into the same reproducible transform used for
         * the existing WebView compatibility fixes.
         */
        .replace(
          'function WA(){',
          'function xO({videoUrl:n}){const[r,i]=g.useState(!1),s=g.useRef(null);g.useEffect(()=>()=>{s.current&&(s.current.pause(),s.current.removeAttribute("src"))},[]);if(!n)return null;return v.jsxs(v.Fragment,{children:[v.jsxs("button",{type:"button",className:"sf-tutorial-banner",onClick:()=>i(!0),children:[v.jsx("span",{className:"sf-tutorial-title",children:"🎬 ऐप कैसे इस्तेमाल करें? (वीडियो देखें)"}),v.jsx("span",{children:"• Daily Task से कॉइन कैसे कमाएं?"}),v.jsx("span",{children:"• 2 घंटे में Bonus कैसे पाएं?"}),v.jsx("span",{children:"• Coins को Redeem कैसे करें?"})]}),r&&v.jsx("div",{className:"sf-tutorial-backdrop",role:"presentation",onClick:()=>i(!1),children:v.jsxs("div",{className:"sf-tutorial-modal",role:"dialog","aria-modal":!0,"aria-label":"Tutorial Video",onClick:e=>e.stopPropagation(),children:[v.jsxs("div",{className:"flex items-center justify-between gap-3 mb-3",children:[v.jsx("h2",{className:"text-lg font-bold text-emerald-300",children:"App Kaise Use Kare"}),v.jsx("button",{type:"button",className:"text-2xl text-white px-2","aria-label":"Close tutorial",onClick:()=>i(!1),children:"×"})]}),v.jsx("video",{ref:s,src:n,controls:!0,playsInline:!0,autoPlay:!0,className:"sf-tutorial-player"})]})})]})}function WA(){'
        )
        .replace(
          'function WA(){const n=ka()||"",{data:r,isLoading:i}=ao(n);return v.jsxs("div",{className:"flex flex-col gap-6",children:[',
          'function WA(){const n=ka()||"",{data:r,isLoading:i}=ao(n),{data:s}=eO();return v.jsxs("div",{className:"flex flex-col gap-6",children:[v.jsx(xO,{videoUrl:s?.videoUrl}),'
        )
        .replace(
          'Wvid&&v.jsxs("div",{className:"rounded-2xl overflow-hidden border border-primary/20 bg-black shadow-lg",children:[v.jsx("p",{className:"text-xs text-primary/70 px-3 pt-2 pb-1 font-semibold uppercase tracking-wider",children:"📹 Tutorial Video"}),v.jsx("video",{src:Wvid,controls:!0,controlsList:"nodownload",className:"w-full",style:{maxHeight:"220px",background:"#000",display:"block"},playsInline:!0})]}),',
          'Wvid&&v.jsx(xO,{videoUrl:Wvid}),'
        )
        /*
         * React Query view hooks now hydrate synchronously from the
         * view-level localStorage cache. The cached object is the initial
         * render only; an older-than-15s entry is silently revalidated and
         * the mounted component receives the fresh result in place.
         */
        .replace(
          'function ao(n,r){const i=MR(n);return{...Gs(i),queryKey:i.queryKey}}',
          'function ao(n,r){const i=MR(n),s=window.__sfReadViewCache?window.__sfReadViewCache(NR(n),{coins:0,totalOrders:0,successfulOrders:0,referrals:0,referralCode:"",referredBy:null,createdAt:"1970-01-01T00:00:00.000Z"}):{data:{coins:0,totalOrders:0,successfulOrders:0,referrals:0,referralCode:"",referredBy:null,createdAt:"1970-01-01T00:00:00.000Z"},updatedAt:0};return{...Gs({...i,initialData:s.data,initialDataUpdatedAt:s.updatedAt,staleTime:15000,refetchOnWindowFocus:!1,retry:1}),queryKey:i.queryKey}}'
        )
        .replace(
          'function qR(n,r){const i=HR(n);return{...Gs(i),queryKey:i.queryKey}}',
          'function qR(n,r){const i=HR(n),s=window.__sfReadViewCache?window.__sfReadViewCache(LR(n),[]):{data:[],updatedAt:0};return{...Gs({...i,initialData:s.data,initialDataUpdatedAt:s.updatedAt,staleTime:15000,refetchOnWindowFocus:!1,retry:1}),queryKey:i.queryKey}}'
        )
        .replace(
          'function eO(){return Gs({queryKey:["public-services"],queryFn:()=>qr("/api/services").then(n=>n.json()),staleTime:6e4})}',
          'function eO(){const n=window.__sfReadViewCache?window.__sfReadViewCache("/api/services",{services:[],offerwallUrl:"",cpaLeadUrl:"",videoUrl:""}):{data:{services:[],offerwallUrl:"",cpaLeadUrl:"",videoUrl:""},updatedAt:0};return Gs({queryKey:["public-services"],queryFn:()=>qr("/api/services").then(r=>r.json()),initialData:n.data,initialDataUpdatedAt:n.updatedAt,staleTime:15000,refetchOnWindowFocus:!1,retry:1})}'
        )
        .replace(
          'function aO(){return Gs({queryKey:["public-services"],queryFn:()=>qr("/api/services").then(n=>n.json()),staleTime:6e4})}',
          'function aO(){const n=window.__sfReadViewCache?window.__sfReadViewCache("/api/services",{services:[],offerwallUrl:"",cpaLeadUrl:"",videoUrl:""}):{data:{services:[],offerwallUrl:"",cpaLeadUrl:"",videoUrl:""},updatedAt:0};return Gs({queryKey:["public-services"],queryFn:()=>qr("/api/services").then(r=>r.json()),initialData:n.data,initialDataUpdatedAt:n.updatedAt,staleTime:15000,refetchOnWindowFocus:!1,retry:1})}'
        )
        /*
         * Keep the authenticated layout mounted for all app tabs. Only the
         * route view changes, inside a React transition, so the header and
         * bottom navigation never disappear during rapid hash changes.
         */
        .replace(
          'function Pl({component:n,...r}){const[i,s]=pf(),u=ka();return g.useEffect(()=>{!u&&i!=="/login"&&s("/login")},[u,i,s]),u?v.jsx(KA,{children:v.jsx(n,{...r})}):null}function hO(){return v.jsxs(lS,{children:[v.jsx(Na,{path:"/login",component:FA}),v.jsx(Na,{path:"/",component:()=>v.jsx(Pl,{component:WA})}),v.jsx(Na,{path:"/services",component:()=>v.jsx(Pl,{component:tO})}),v.jsx(Na,{path:"/earn",component:()=>v.jsx(Pl,{component:rO})}),v.jsx(Na,{path:"/orders",component:()=>v.jsx(Pl,{component:iO})}),v.jsx(Na,{path:"/referrals",component:()=>v.jsx(Pl,{component:fO})}),v.jsx(Na,{children:v.jsx("div",{className:"p-8 text-center",children:"Not Found"})})]})}',
          'function Pl(){const[n,r]=pf(),i=ka();g.useEffect(()=>{!i&&n!=="/login"&&r("/login")},[i,n,r]);const h=n==="/"?WA:n==="/services"?tO:n==="/earn"?rO:n==="/orders"?iO:n==="/referrals"?fO:null;return i?v.jsx(KA,{children:h?v.jsx(h,{}):v.jsx("div",{className:"p-8 text-center",children:"Not Found"})}):null}function hO(){return v.jsxs(lS,{children:[v.jsx(Na,{path:"/login",component:FA}),v.jsx(Na,{component:Pl})]})}'
        )
        /*
         * CPA/offer callbacks can arrive more than once from Android
         * WebViews. Credit sync and the following profile refresh are
         * therefore accepted at most once per user every 15 seconds.
         */
        .replace(
          'const w=g.useCallback(async R=>{if(!(!R||R<=0))try{',
          'const w=g.useCallback(async R=>{if(!(!R||R<=0)&&(window.__sfCanSync?window.__sfCanSync("coins:"+n,15000):!0))try{'
        )
        .replace('const nC="/assets/', 'const nC=(window.__SF_BASE_PATH||"")+"/assets/')
        .replace('const ZA="/assets/', 'const ZA=(window.__SF_BASE_PATH||"")+"/assets/')
        .replace('const JA="/assets/', 'const JA=(window.__SF_BASE_PATH||"")+"/assets/')
        .replace(
          /https:\/\/star-follower\.netlify\.app`;window\.open\(`https:\/\/wa\.me\/\?text=\$\{encodeURIComponent\(q\)\}`,"_blank"\)/,
          'https://star-follower.github.io/Official/`;window.__sfShare(q,"Star Follower")'
        )
        .replace(' WhatsApp पर शेयर करें', ' दोस्तों के साथ शेयर करें')
        .replace(
          'N=async E=>{E.preventDefault();const A=h.trim();if(A){b(!0)',
          'N=async E=>{E.preventDefault();const A=h.trim();if(!/^[A-Za-z0-9]{6}$/.test(A)){S({variant:"destructive",title:"कृपया 6-अंकीय Recovery Code डालें!"});return}if(A){b(!0)'
        )
        .replace(
          'placeholder:"6-digit Recovery Code",value:h,onChange:E=>p(E.target.value.replace(/\\D/g,"").slice(0,6)),className:"bg-card/50 border-primary/20 focus-visible:ring-primary h-14 text-center tracking-[0.5em] text-xl font-mono",inputMode:"numeric",maxLength:6,autoFocus:!0}',
          'placeholder:"6-character Recovery Code",value:h,onChange:E=>p(E.target.value.replace(/[^a-zA-Z0-9]/g,"").toUpperCase().slice(0,6)),className:"bg-card/50 border-primary/20 focus-visible:ring-primary h-14 text-center tracking-[0.5em] text-xl font-mono",type:"text",maxLength:6,autoFocus:!0}'
        )
        .replace(
          'https://star-follower.netlify.app',
          'https://star-follower.github.io/Official/'
        );
      var sfBundleBlob = URL.createObjectURL(
        new Blob([sfBundle], { type: 'text/javascript' })
      );
      await import(sfBundleBlob);
      URL.revokeObjectURL(sfBundleBlob);
  };

  /* ── 7) APP SHELL: settings gear + modal, APK banner ───────── */
  function initShellUi() {
      var GEAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      function sfLoggedIn() {
        return !!(localStorage.getItem('sf_user_id') && localStorage.getItem('sf_token'));
      }
      var sfModal = document.getElementById('sf-settings-modal');

      function openSettings()  { sfModal.classList.add('open'); }
      function closeSettings() { sfModal.classList.remove('open'); }

      document.getElementById('sf-modal-close').addEventListener('click', closeSettings);

      document.getElementById('sf-logout-btn').addEventListener('click', function () {
        /* Clear all auth keys */
        ['sf_user_id','sf_token'].forEach(function (k) { localStorage.removeItem(k); });
        closeSettings();
        /* Hard-navigate so React Router sends user back to /login */
        window.location.replace(window.__sfAppPath('/'));
      });

      /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
         HEADER LOGOUT → SETTINGS GEAR
         ─────────────────────────────────────────────────────────
         Three-layer defense:
           Layer 1 – CSS already hides the original button above.
           Layer 2 – patchLogout() replaces it with our gear button.
           Layer 3 – setInterval + MutationObserver re-run
                     patchLogout() if React ever re-renders it.
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
      function patchLogout() {
        /* Find the logout button: class contains both markers,
           AND has NOT been patched yet (no data-sf-done). */
        var btn = document.querySelector(
          'header button:not([data-sf-done])[class*="hover:text-foreground"][class*="p-1"]'
        );
        if (!btn) return; /* already patched or header not rendered yet */

        var parent = btn.parentNode;
        if (!parent) return;

        /* Build our replacement — a fresh element with the SAME
           Tailwind classes so it inherits the same visual style. */
        var gear = document.createElement('button');
        gear.className         = btn.className; /* keep Tailwind styles */
        gear.setAttribute('data-sf-done', 'true');
        gear.setAttribute('title',        'Settings');
        gear.setAttribute('aria-label',   'Settings');
        gear.innerHTML = GEAR_SVG;

        /* Native listener in CAPTURE phase beats React's bubble phase */
        gear.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          openSettings();
        }, true /* capture */);

        /* Swap nodes — removes the original button (and its React
           fiber listeners) from the live DOM entirely. */
        parent.replaceChild(gear, btn);
      }

      /* Layer 3a — a short startup poll only. A tab switch replaces the
         whole view subtree, so a 300 ms querySelector poll used to land
         right on top of the new render; 1 s for 8 s then 3 s is plenty
         and costs nothing perceptible. Paused while the app is hidden. */
      var _pollLogout = function () { if (!document.hidden) patchLogout(); };
      var _fast = setInterval(_pollLogout, 1000);
      setTimeout(function () {
        clearInterval(_fast);
        setInterval(_pollLogout, 3000);
      }, 8000);

      /* Layer 3b — MutationObserver, COALESCED. React inserting a whole
         tab view fires hundreds of mutation records; running a DOM query
         per record blocked the main thread on every tab tap. Now the
         observer only flags work and patchLogout() runs once, after the
         next paint, in idle time. */
      var _schedulePatchLogout = window.__sfCoalesce
        ? window.__sfCoalesce(patchLogout)
        : function () { setTimeout(patchLogout, 32); };
      new MutationObserver(_schedulePatchLogout)
        .observe(document.body, { childList: true, subtree: true });

      var APK_DOWNLOAD_URL = 'https://files.catbox.moe/4709nq.apk';
      var _apkBanner = document.getElementById('sf-apk-banner');
      var _apkInstallButton = document.getElementById('sf-apk-install');
      var _apkDismiss = function () {
        _apkBanner.style.display = 'none';
        sessionStorage.setItem('apk-dismissed', '1');
      };

      function isStandaloneMode() {
        var ua = navigator.userAgent || '';
        var isAndroidWebView =
          /android/i.test(ua) &&
          (/\bwv\b/i.test(ua) ||
           /;\s*wv\)/i.test(ua) ||
           /; wv/i.test(ua) ||
           window.__SF_APK_MODE === true);
        return window.matchMedia('(display-mode: standalone)').matches ||
          window.matchMedia('(display-mode: fullscreen)').matches ||
          window.matchMedia('(display-mode: minimal-ui)').matches ||
          window.navigator.standalone === true ||
          window.__SF_APK_MODE === true ||
          localStorage.getItem('sf_apk_installed') === '1' ||
          /StarFollower|Star Follower/i.test(ua) ||
          isAndroidWebView;
      }

      function hideApkBanner() {
        if (!_apkBanner) return;
        _apkBanner.classList.add('sf-apk-hidden');
        _apkBanner.style.setProperty('display', 'none', 'important');
      }

      function showApkBanner() {
        if (isStandaloneMode()) {
          hideApkBanner();
          return;
        }
        _apkBanner.classList.remove('sf-apk-hidden');
        _apkBanner.style.removeProperty('display');
        if (!sessionStorage.getItem('apk-dismissed')) _apkBanner.style.display = 'block';
      }

      if (isStandaloneMode()) hideApkBanner();
      window.addEventListener('load', showApkBanner);
      _apkInstallButton.addEventListener('click', function () {
        window.location.assign(APK_DOWNLOAD_URL);
      });
      document.getElementById('sf-apk-dismiss').addEventListener('click', _apkDismiss);
      document.getElementById('sf-apk-close').addEventListener('click', _apkDismiss);
  }
  if (document.body) {
    initShellUi();
  } else {
    document.addEventListener('DOMContentLoaded', initShellUi, { once: true });
  }
}(window, document));
