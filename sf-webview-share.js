/* ═══════════════════════════════════════════════════════════════════
   sf-webview-share.js
   ───────────────────────────────────────────────────────────────────
   Native Android share for Star Follower, robust inside a WebView/APK.

   WHY THIS IS NEEDED
   The Web Share API (navigator.share) only works inside a WebView if
   the wrapper's WebChromeClient implements onShowFileChooser-style
   support for it (Android's WebView added share-sheet support around
   WebView/Chrome 89+, but many APK wrapper generators don't enable
   it, or block it entirely). In that case navigator.share either:
     - does not exist,
     - exists but rejects/throws immediately, or
     - throws asynchronously with an unhandled promise rejection
       that never reaches a .catch() written deep inside a minified
       bundle.
   This file defines a single, defensive entry point — window.__sfShare
   — that the app (and the compiled bundle) calls instead of touching
   navigator.share directly, plus a global safety net for rejections
   that slip through anyway.
   ═══════════════════════════════════════════════════════════════════ */
(function (window, document) {
  'use strict';

  function isAndroid() {
    return /android/i.test(navigator.userAgent || '');
  }

  /* Opens a URL the way that best matches the current runtime:
     - Android WebView: window.open (Chrome Custom Tab) or location fallback
     - Everything else: window.open with noopener */
  function openUrl(url) {
    var win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) window.location.href = url;
  }

  /* Final-resort fallback when neither a native bridge nor
     navigator.share is usable: hand the text to WhatsApp directly.
     On Android we try the app deep link first (whatsapp://) so the
     WhatsApp app itself opens instead of a browser tab; if nothing
     intercepts that scheme within ~1.2s (app not installed, or the
     WebView refuses custom schemes) we fall back to the wa.me web
     link, which always works in a Custom Tab / browser. */
  function shareFallback(text) {
    var encoded = encodeURIComponent(text);
    var waWebUrl = 'https://wa.me/?text=' + encoded;

    if (!isAndroid()) {
      openUrl(waWebUrl);
      return;
    }

    var waAppUrl = 'whatsapp://send?text=' + encoded;
    var settled = false;

    var fallbackTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      openUrl(waWebUrl);
    }, 1200);

    /* If the WhatsApp app intercepts the scheme, the WebView/page is
       backgrounded almost immediately — cancel the web fallback. */
    function onVisibilityDrop() {
      if (document.hidden) {
        settled = true;
        clearTimeout(fallbackTimer);
      }
    }
    document.addEventListener('visibilitychange', onVisibilityDrop, { once: true });
    window.addEventListener('blur', onVisibilityDrop, { once: true });

    try {
      window.location.href = waAppUrl;
    } catch (e) {
      clearTimeout(fallbackTimer);
      openUrl(waWebUrl);
    }
  }

  /**
   * window.__sfShare(text, title, url)
   * Call this instead of navigator.share / wa.me directly anywhere
   * in the app. Must be invoked synchronously from a user gesture
   * (tap handler) — required by both the Web Share API and Android
   * intent scheme navigation.
   */
  function sfShare(text, title, url) {
    title = title || 'Star Follower';
    var payload = { title: title, text: text };
    if (url) payload.url = url;

    /* 1) A native bridge the APK wrapper may have injected
          (e.g. window.Android.shareText, common in WebView
          wrapper templates that expose @JavascriptInterface). */
    try {
      if (window.Android && typeof window.Android.shareText === 'function') {
        window.Android.shareText(text);
        return;
      }
    } catch (e) { /* fall through */ }

    /* 2) GoNative-style bridge, already referenced elsewhere in this app. */
    try {
      if (window.gonative && window.gonative.share &&
          typeof window.gonative.share.share === 'function') {
        window.gonative.share.share(payload);
        return;
      }
    } catch (e) { /* fall through */ }

    /* 3) Standard Web Share API. Guard both the synchronous throw
          (permission denied, insecure context, not implemented in
          this WebView build) and the async promise rejection. */
    if (typeof navigator.share === 'function') {
      try {
        var result = navigator.share(payload);
        if (result && typeof result.catch === 'function') {
          result.catch(function (err) {
            // AbortError = user cancelled the native sheet — respect that,
            // don't force WhatsApp on them.
            if (err && err.name === 'AbortError') return;
            shareFallback(text);
          });
        }
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        // Synchronous throw — WebView doesn't actually support it
        // despite navigator.share existing. Fall through to fallback.
      }
    }

    /* 4) No native bridge, no working Web Share API. */
    shareFallback(text);
  }

  window.__sfShare = sfShare;

  /* Global safety net: some WebViews resolve navigator.share's promise
     on a later microtask outside of any reachable .catch(), especially
     when called from deep inside a minified bundle. Prevent it from
     surfacing as a red console error / crashing the WebView bridge. */
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    var msg = (reason && (reason.message || String(reason))) || '';
    if (/share/i.test(msg) || (reason && reason.name === 'NotAllowedError')) {
      event.preventDefault();
    }
  });
}(window, document));