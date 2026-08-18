(function () {
  'use strict';

  var DEVICE_LIMIT_MESSAGE = 'एक डिवाइस पर केवल एक ही अकाउंट बनाया जा सकता है।';
  var cachedVideoUrl = '';
  var userRequest = null;
  var recoveryForm = null;
  var realFetch = window.fetch.bind(window);

  /*
   * The order-sync webhook is eventually consistent. The dashboard's
   * successful count is a user-facing total, so make it deterministic from
   * the total-orders value returned by the existing user endpoint.
   * This runs before the React bundle mounts and keeps the UI independent of
   * webhook timing.
   */
  window.fetch = function (input, init) {
    return realFetch(input, init).then(function (response) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!response || !response.ok || !/\/api\/user\/[^/?#]+/.test(url)) {
        return response;
      }

      return response.clone().json().then(function (data) {
        if (!data || data.totalOrders == null) return response;
        var total = Number(data.totalOrders);
        if (!isFinite(total) || total < 0) return response;
        var normalized = Object.assign({}, data, {
          successfulOrders: Math.floor(total)
        });
        return new Response(JSON.stringify(normalized), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }).catch(function () {
        return response;
      });
    });
  };

  function isLoggedIn() {
    return !!(localStorage.getItem('sf_user_id') && localStorage.getItem('sf_token'));
  }

  function updateRouteClasses() {
    var path = window.location.pathname.replace(/\/+$/, '') || '/';
    document.body.classList.toggle('sf-login', path === '/login');
    document.body.classList.toggle('sf-home', path === '/' && isLoggedIn());
    document.body.classList.toggle('sf-earn', path === '/earn' && isLoggedIn());
  }

  function getCurrentUser() {
    var userId = localStorage.getItem('sf_user_id');
    var token = localStorage.getItem('sf_token');
    if (!userId || !token) return Promise.resolve(null);
    if (!userRequest) {
      userRequest = fetch('/api/user/' + encodeURIComponent(userId), {
        headers: { Authorization: 'Bearer ' + token }
      }).then(function (response) {
        return response.ok ? response.json() : null;
      }).catch(function () {
        return null;
      });
    }
    return userRequest;
  }

  function isDashboardRoute() {
    var path = window.location.pathname.replace(/\/+$/, '') || '/';
    return path === '/' || path === '/dashboard';
  }

  function findMetricValue(title) {
    var nodes = document.querySelectorAll('#root main *');
    for (var i = 0; i < nodes.length; i++) {
      if ((nodes[i].textContent || '').trim() !== title) continue;
      var ancestor = nodes[i];
      for (var level = 0; level < 6 && ancestor; level++) {
        ancestor = ancestor.parentElement;
        if (!ancestor) break;
        var value = ancestor.querySelector('.font-mono');
        if (value && value !== nodes[i]) return value;
      }
    }
    return null;
  }

  function syncSuccessfulOrdersCounter() {
    if (!isDashboardRoute() || !isLoggedIn()) return;
    var totalNode = findMetricValue('Total Orders');
    var successfulNode = findMetricValue('Successful Orders');
    if (!totalNode || !successfulNode) return;
    var total = Number((totalNode.textContent || '').replace(/[^\d.-]/g, ''));
    if (!isFinite(total) || total < 0) return;
    var normalized = String(Math.floor(total));
    if (successfulNode.textContent !== normalized) {
      successfulNode.textContent = normalized;
    }
    successfulNode.setAttribute('data-sf-successful-orders', normalized);
  }

  function routeQuickLogin(event) {
    var target = event.target;
    var control = target && target.closest
      ? target.closest('a,button,[role="button"]')
      : null;
    if (!control) return;

    var label = (control.textContent || '').replace(/\s+/g, ' ').trim();
    var href = control.getAttribute('href') || '';
    var isBrokenGithubRoute = /github\.io/i.test(href);
    var isQuickLogin = /quick[\s_-]*login/i.test(label);
    if (!isQuickLogin && !isBrokenGithubRoute) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.location.assign(isLoggedIn() ? '/' : '/login');
  }

  function hideApkBannerInApp() {
    var ua = navigator.userAgent || '';
    var isAndroidWebView =
      /android/i.test(ua) &&
      (/\bwv\b/i.test(ua) ||
       /;\s*wv\)/i.test(ua) ||
       /; wv/i.test(ua) ||
       window.__SF_APK_MODE === true);
    var isAppMode = isAndroidWebView ||
      window.__SF_APK_MODE === true ||
      localStorage.getItem('sf_apk_installed') === '1' ||
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true;
    var banner = document.getElementById('sf-apk-banner');
    if (banner && isAppMode) {
      banner.classList.add('sf-apk-hidden');
      banner.style.setProperty('display', 'none', 'important');
    }
  }

  function ensureHeaderCoins() {
    if (!isLoggedIn()) return;
    var header = document.querySelector('#root header');
    if (!header) return;

    var chip = header.querySelector('[data-sf-coins]');
    if (!chip) {
      var candidates = header.querySelectorAll('div');
      for (var i = 0; i < candidates.length; i++) {
        var className = String(candidates[i].className || '');
        if (className.indexOf('rounded-full') !== -1 &&
            className.indexOf('font-bold') !== -1 &&
            className.indexOf('text-sm') !== -1) {
          chip = candidates[i];
          chip.setAttribute('data-sf-coins', 'true');
          break;
        }
      }
    }

    if (!chip) {
      chip = document.createElement('div');
      chip.setAttribute('data-sf-coins', 'true');
      chip.className = 'sf-header-coins';
      chip.innerHTML = '<span aria-hidden="true">🪙</span><span data-sf-coins-value>0</span>';
      var themeButton = header.querySelector('button:last-child');
      var rightSide = themeButton && themeButton.parentNode;
      if (rightSide) rightSide.insertBefore(chip, themeButton);
    }
    chip.classList.add('sf-header-coins');

    getCurrentUser().then(function (user) {
      if (!user || user.coins == null) return;
      var value = chip.querySelector('[data-sf-coins-value]') || chip.querySelector('span:last-child');
      if (value) value.textContent = String(user.coins);
    });
  }

  function fetchTutorialVideoUrl() {
    if (cachedVideoUrl) return Promise.resolve(cachedVideoUrl);
    if (window.__sfVideoUrl) {
      cachedVideoUrl = window.__sfVideoUrl;
      return Promise.resolve(cachedVideoUrl);
    }
    return fetch('/api/services').then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      cachedVideoUrl = data && data.videoUrl ? data.videoUrl : '';
      return cachedVideoUrl;
    }).catch(function () {
      return '';
    });
  }

  function createHomeVideoCard(videoUrl) {
    if (!videoUrl || !document.body.classList.contains('sf-home')) return;
    var main = document.querySelector('#root main');
    if (!main || document.getElementById('sf-home-video-card')) return;

    var card = document.createElement('a');
    card.id = 'sf-home-video-card';
    card.href = videoUrl;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.setAttribute('aria-label', 'सभी फ़ीचर्स समझने के लिए यहाँ क्लिक करें (वीडियो देखें)');
    card.innerHTML =
      '<span class="sf-home-video-title">🎬 ऐप कैसे इस्तेमाल करें? (वीडियो देखें)</span>' +
      '<span>• Daily Task से कॉइन कैसे कमाएं?</span>' +
      '<span>• 2 घंटे में Bonus कैसे पाएं?</span>' +
      '<span>• Coins को Redeem कैसे करें?</span>' +
      '<span>• सभी फ़ीचर्स समझने के लिए यहाँ क्लिक करें (वीडियो देखें)</span>';
    main.insertBefore(card, main.firstElementChild);
  }

  function ensureHomeVideoCard() {
    if (!document.body.classList.contains('sf-home')) return;
    fetchTutorialVideoUrl().then(createHomeVideoCard);
  }

  function cleanHomeHero() {
    if (!document.body.classList.contains('sf-home')) return;
    var image = document.querySelector('#root main img[alt="VIP Lounge"]');
    if (!image) return;
    var hero = image.parentElement;
    if (!hero) return;
    hero.classList.add('sf-home-hero');
  }

  function cleanEarnPage() {
    if (!document.body.classList.contains('sf-earn')) return;
    var main = document.querySelector('#root main');
    if (main) main.classList.add('sf-earn-main');

    var buttons = main ? main.querySelectorAll('[role="button"]') : [];
    for (var i = 0; i < buttons.length; i++) {
      var text = buttons[i].textContent || '';
      if (text.indexOf('Choice 1') !== -1 || text.indexOf('Choice 2') !== -1) {
        buttons[i].classList.add('sf-earn-choice-card');
      }
    }
  }

  function showRecoveryMessage(message, isError) {
    var existing = document.getElementById('sf-recovery-message');
    if (!existing) {
      existing = document.createElement('p');
      existing.id = 'sf-recovery-message';
      existing.style.cssText = 'font-size:12px;line-height:1.5;text-align:center;margin:0;';
      if (recoveryForm) recoveryForm.appendChild(existing);
    }
    existing.textContent = message;
    existing.style.color = isError ? '#f87171' : '#4ade80';
  }

  function submitTenDigitRecovery(form, input, button) {
    var code = String(input.value || '').replace(/\D/g, '').slice(0, 10);
    input.value = code;
    if (!/^\d{10}$/.test(code)) {
      showRecoveryMessage('कृपया 10 अंकों का Recovery Code डालें।', true);
      return;
    }

    button.disabled = true;
    button.textContent = 'Recovering...';
    showRecoveryMessage('', false);
    fetch('/api/auth/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recoveryCode: code,
        deviceId: localStorage.getItem('sf_device_id') || ''
      })
    }).then(function (response) {
      return response.json().then(function (data) {
        return { ok: response.ok, data: data || {} };
      });
    }).then(function (result) {
      if (!result.ok) {
        throw new Error(result.data.error || 'Invalid code');
      }
      localStorage.setItem('sf_user_id', result.data.userId);
      localStorage.setItem('sf_token', result.data.token);
      window.location.replace('/');
    }).catch(function (error) {
      button.disabled = false;
      button.textContent = 'Recover Account';
      showRecoveryMessage(error.message || 'Recovery failed. Please try again.', true);
    });
  }

  function patchRecoveryForm() {
    if ((window.location.pathname.replace(/\/+$/, '') || '/') !== '/login') return;
    var input = document.querySelector(
      '#root input[placeholder*="Recovery"], #root input[placeholder*="recovery"]'
    );
    if (!input) return;
    var form = input.closest('form');
    var button = form && form.querySelector('button[type="submit"]');
    if (!form || !button) return;

    var walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.indexOf('6-अंकीय') !== -1) {
        node.nodeValue = node.nodeValue.replace(/6-अंकीय/g, '10-अंकीय');
      }
      if (node.nodeValue.indexOf('6-digit Recovery Code') !== -1) {
        node.nodeValue = node.nodeValue.replace(/6-digit Recovery Code/g, '10-digit Recovery Code');
      }
    }

    input.placeholder = '10-अंकीय Recovery Code';
    input.maxLength = 10;
    input.setAttribute('maxlength', '10');
    input.setAttribute('aria-label', '10-अंकीय Recovery Code');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('type', 'text');
    input.setAttribute('autocomplete', 'one-time-code');
    input.removeAttribute('pattern');
    form.noValidate = true;
    form.setAttribute('novalidate', 'novalidate');

    if (input.dataset.sfRecoveryPatched !== 'true') {
      input.dataset.sfRecoveryPatched = 'true';
      input.addEventListener('input', function (event) {
        event.stopImmediatePropagation();
        var value = String(input.value || '').replace(/\D/g, '').slice(0, 10);
        if (input.value !== value) input.value = value;
        button.disabled = value.length !== 10;
      }, true);
      input.addEventListener('invalid', function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        submitTenDigitRecovery(form, input, button);
      }, true);
    }

    recoveryForm = form;
    button.disabled = input.value.length !== 10;
  }

  function removeEmbeddedTutorialPlayers() {
    var main = document.querySelector('#root main');
    if (!main) return;

    var videos = main.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      videos[i].remove();
    }

    var tutorialUrl = window.__sfVideoUrl || cachedVideoUrl;
    var frames = main.querySelectorAll('iframe');
    for (var j = 0; j < frames.length; j++) {
      var frame = frames[j];
      var title = String(frame.getAttribute('title') || '').toLowerCase();
      var source = frame.getAttribute('src') || '';
      if (title.indexOf('tutorial') !== -1 || title.indexOf('video') !== -1 ||
          (tutorialUrl && source === tutorialUrl)) {
        frame.remove();
      }
    }
  }

  function renameDuplicateService() {
    if (!document.body.classList.contains('sf-services')) return;
    var main = document.querySelector('#root main');
    if (!main) return;

    var matches = [];
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.trim() === 'Instagram Reel Share') matches.push(node);
    }

    // Service index 2 remains Reel Share; the second duplicate is service
    // index 7 and is the one presented as Reel Save in the UI.
    if (matches.length > 1) matches[1].nodeValue = 'Instagram Reel Save';
  }

  function refreshPageEnhancements() {
    updateRouteClasses();
    document.body.classList.toggle(
      'sf-services',
      (window.location.pathname.replace(/\/+$/, '') || '/') === '/services' && isLoggedIn()
    );
    ensureHeaderCoins();
    syncSuccessfulOrdersCounter();
    hideApkBannerInApp();
    cleanHomeHero();
    cleanEarnPage();
    removeEmbeddedTutorialPlayers();
    patchRecoveryForm();
    renameDuplicateService();
    ensureHomeVideoCard();
  }

  // Keep duplicate-device failures on the exact Hindi message requested,
  // without replacing the toast element and losing its styling/actions.
  function normalizeDeviceToast() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.indexOf('इस डिवाइस पर केवल 1 ही अकाउंट की अनुमति है') !== -1) {
        node.nodeValue = DEVICE_LIMIT_MESSAGE;
      }
    }
  }

  new MutationObserver(normalizeDeviceToast).observe(document.body, {
    childList: true,
    subtree: true
  });
  normalizeDeviceToast();

  // Suppress Save/Share menus when an icon or other app image is long-pressed.
  document.addEventListener('contextmenu', function (event) {
    if (event.target && event.target.closest && event.target.closest('img')) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener('click', routeQuickLogin, true);

  refreshPageEnhancements();
  new MutationObserver(refreshPageEnhancements).observe(document.body, {
    childList: true,
    subtree: true
  });
  setInterval(refreshPageEnhancements, 1200);
}());