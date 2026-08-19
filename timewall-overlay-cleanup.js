(function () {
  'use strict';

  function removeTimeWallOverlay() {
    document.querySelectorAll('.modal-backdrop, .modal-overlay, #overlay, [class*="backdrop"]').forEach(el => el.remove());
    document.body.style.overflow = 'auto';

    // The React close handler normally unmounts this container. Remove it as
    // a fallback as well so a stale iframe can never cover the Earn page.
    var iframe = document.querySelector('iframe[title="Earn Coins"]');
    if (iframe) {
      var container = iframe.closest('div[class*="fixed"][class*="inset-0"]');
      if (container) container.remove();
    }
  }

  function isTimeWallCloseControl(element) {
    if (!document.querySelector('iframe[title="Earn Coins"]')) return false;

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
  window.addEventListener('popstate', removeTimeWallOverlay);
  window.addEventListener('hashchange', removeTimeWallOverlay);
}());