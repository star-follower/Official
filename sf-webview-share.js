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

  function closeInAppBrowserFallback() {
    var overlay = document.getElementById('sf-in-app-browser-overlay');
    if (!overlay) return;
    overlay.remove();
    document.body.classList.remove('sf-in-app-browser-open');
    document.documentElement.classList.remove('sf-in-app-browser-open');
  }

  /*
   * Browser.open is the primary path in the Capacitor APK. This fallback is
   * deliberately an iframe mounted inside the current app document: it never
   * calls window.open(), an external intent, or location.assign().
   */
  function openInAppBrowserFallback(url) {
    closeInAppBrowserFallback();

    var overlay = document.createElement('div');
    overlay.id = 'sf-in-app-browser-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Offer');

    var header = document.createElement('div');
    header.className = 'sf-in-app-browser-header';

    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'sf-in-app-browser-back';
    back.setAttribute('aria-label', 'Close offer');
    back.textContent = '✕ Back';
    back.addEventListener('click', closeInAppBrowserFallback);

    var frame = document.createElement('iframe');
    frame.className = 'sf-in-app-browser-frame';
    frame.title = 'Offer';
    frame.setAttribute('data-sf-in-app-browser-frame', 'true');
    frame.src = url;
    frame.setAttribute('allow', 'autoplay; camera; microphone; payment');
    frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');

    header.appendChild(back);
    overlay.appendChild(header);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    document.body.classList.add('sf-in-app-browser-open');
    document.documentElement.classList.add('sf-in-app-browser-open');
    back.focus();
    return true;
  }

  /*
   * Open a task/update URL in Capacitor's in-app Browser first. The APK
   * exposes the official plugin through Capacitor.Plugins.Browser, so this
   * follows the same behavior as Browser.open({ url }) without handing the
   * URL to the outer Chrome app.
   *
   * Native wrappers differ in the bridge method they expose, so support the
   * common Android, React Native WebView, and GoNative shapes after the
   * Capacitor plugin. When no bridge exists, same-document navigation keeps
   * the URL inside the current WebView and Android Back returns to the app.
   */
  function openInAppBrowser(url) {
    if (!url || !/^https?:\/\//i.test(String(url))) return false;
    url = String(url);

    try {
      var capacitor = window.Capacitor;
      var Browser = capacitor && capacitor.Plugins && capacitor.Plugins.Browser;
      if (Browser && typeof Browser.open === 'function') {
        var openResult = Browser.open({ url: url });
        if (openResult && typeof openResult.catch === 'function') {
          openResult.catch(function () {
            openInAppBrowserFallback(url);
          });
        }
        return true;
      }
    } catch (e) {}

    var bridges = [
      [window.Android, ['openInAppBrowser', 'openCustomTab']],
      [window.SFAndroid, ['openInAppBrowser', 'openCustomTab']],
      [window.AndroidShare, ['openInAppBrowser', 'openCustomTab']]
    ];
    for (var i = 0; i < bridges.length; i++) {
      var bridge = bridges[i][0];
      var methods = bridges[i][1];
      if (!bridge) continue;
      for (var j = 0; j < methods.length; j++) {
        try {
          if (typeof bridge[methods[j]] === 'function') {
            bridge[methods[j]](url);
            return true;
          }
        } catch (e) {}
      }
    }

    try {
      if (window.gonative && window.gonative.webview) {
        if (typeof window.gonative.webview.open === 'function') {
          window.gonative.webview.open(url);
          return true;
        }
      }
    } catch (e) {}

    try {
      if (window.ReactNativeWebView &&
          typeof window.ReactNativeWebView.postMessage === 'function') {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'open_in_app_browser',
          url: url
        }));
        return true;
      }
    } catch (e) {}

    return openInAppBrowserFallback(url);
  }

  window.__sfOpenInAppBrowser = openInAppBrowser;

  /* Final-resort fallback when neither a native bridge nor
     navigator.share is usable: hand the text to WhatsApp directly.
     Never open wa.me/api.whatsapp.com here; those URLs are what route the
     user into the outer browser instead of the installed WhatsApp app. */
  function shareFallback(text) {
    var encoded = encodeURIComponent(text);
    var waAppUrl = 'whatsapp://send?text=' + encoded;
    var settled = false;

    var fallbackTimer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text);
        }
      } catch (e) {}
      try {
        window.dispatchEvent(new CustomEvent('sf-share-unavailable', {
          detail: { text: text }
        }));
      } catch (e) {}
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
      try {
        window.dispatchEvent(new CustomEvent('sf-share-unavailable', {
          detail: { text: text }
        }));
      } catch (ignore) {}
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