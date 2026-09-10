(function () {
  'use strict';

  function initTimeWallCleanup() {
    function removeTimeWallOverlay() {
      try {
        document.querySelectorAll('.sf-offerwall-overlay').forEach(function (el) {
          el.remove();
        });
        if (document.body) {
          document.body.style.overflow = '';
          document.body.style.pointerEvents = 'auto';
        }
        if (document.documentElement) {
          document.documentElement.style.pointerEvents = 'auto';
        }
      } catch (e) {}
    }

    function isTimeWallCloseControl(element) {
    if (!document.querySelector('.sf-offerwall-overlay iframe[title="Earn Coins"]')) return false;

    var control = element && element.closest
      ? element.closest('button, [role="button"], a')
      : null;
    if (!control) return false;

    var label = (
      control.getAttribute('aria-label') ||
      control.getAttribute('title') ||
      control.textContent ||
      ''
    ).trim().toLowerCase();

    return label === 'back' ||
      label === 'close' ||
      label.indexOf('back') !== -1 ||
      label.indexOf('close') !== -1;
    }

  // React removes the TimeWall view after its click handler runs. Queue the
  // cleanup so it runs immediately after that state update.
    document.addEventListener('click', function (event) {
      if (isTimeWallCloseControl(event.target)) {
        setTimeout(removeTimeWallOverlay, 0);
      }
    }, true);

    // Covers browser/device back navigation while the offerwall is open.
    window.addEventListener('popstate', function () {
      try { removeTimeWallOverlay(); } catch (e) {}
    });
    window.addEventListener('hashchange', function () {
      try { removeTimeWallOverlay(); } catch (e) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTimeWallCleanup, { once: true });
  } else {
    setTimeout(initTimeWallCleanup, 0);
  }
}());