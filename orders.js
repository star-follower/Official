/* ══════════════════════════════════════════════════════════════
   orders.js — Order history tracking + completion toast
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function sfLoggedIn() {
    return !!(localStorage.getItem('sf_user_id') && localStorage.getItem('sf_token'));
  }

  function initOrderToast() {
        var SVC = [
          'Instagram Followers [90 Days Guarantee]',
          'Instagram Followers [High Quality]',
          'Instagram Likes [90 Days Guarantee]',
          'Instagram Likes [Fast Delivery]',
          'Instagram Story Views', 'Instagram Reel Views',
          'Instagram Post Views', 'Instagram Saves', 'Instagram Comments'
        ];

        var toast    = document.getElementById('sf-order-toast');
        var toastMsg = document.getElementById('sf-toast-msg');
        var _timer   = null;
        var _lastChk = 0;
        var INTERVAL = 60000;

        toast.addEventListener('click', function () {
          clearTimeout(_timer);
          toast.classList.remove('show');
        });

        function showToast(msg) {
          clearTimeout(_timer);
          toastMsg.textContent = msg;
          toast.classList.add('show');
          _timer = setTimeout(function () { toast.classList.remove('show'); }, 9000);
        }

        function checkCompleted() {
          if (!sfLoggedIn()) return;
          var now = Date.now();
          if (now - _lastChk < INTERVAL) return;
          _lastChk = now;

          var uid   = localStorage.getItem('sf_user_id');
          var token = localStorage.getItem('sf_token');

          fetch('/api/user/' + uid, {
            headers: { Authorization: 'Bearer ' + token }
          })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var list = (data && Array.isArray(data.newCompleted)) ? data.newCompleted : [];
            list.forEach(function (o, i) {
              setTimeout(function () {
                showToast(
                  'आपका ' + o.quantity + ' ' +
                  (SVC[o.serviceIndex] || 'Service') +
                  ' का ऑर्डर सफलतापूर्वक पूरा हो चुका है! 🎉'
                );
              }, i * 10000);
            });
          })
          .catch(function () {});
        }

        setTimeout(function () {
          checkCompleted();
          setInterval(checkCompleted, INTERVAL);
        }, 5000);

        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) { _lastChk = 0; checkCompleted(); }
        });
  }
  if (document.body) {
    initOrderToast();
  } else {
    document.addEventListener('DOMContentLoaded', initOrderToast, { once: true });
  }
}());
