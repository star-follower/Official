/* ══════════════════════════════════════════════════════════════
   services.js — VIP Services / Instagram order rendering support
   ──────────────────────────────────────────────────────────────
     1. React-controlled input updater
     2. Tutorial video upload to Supabase Storage (admin portal)
     3. Admin "Tutorial Video URL" field enhancement
     4. /api/services interception -> window.__sfCpaLeadUrl for earn.js
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

      var SUPABASE_URL      = 'https://lgqovwlmicjinwrteivn.supabase.co';
      var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxncW92d2xtaWNqaW53cnRlaXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzOTI2NzAsImV4cCI6MjA5Nzk2ODY3MH0.uFU2sczoAZYUcVdZQG-8IGizw2XfFlRY7sbxqaPuEzs';
      var STORAGE_BUCKET    = 'tutorial-videos';

      // ── React input updater ─────────────────────────────────────────────
      // Updates a React-controlled <input> value AND fires the synthetic
      // onChange so React state is updated correctly.
      var _nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;

      function setReactInputValue(inputEl, newValue) {
        _nativeSetter.call(inputEl, newValue);
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // ── Upload MP4 to Supabase Storage ──────────────────────────────────
      async function uploadVideoFile(file, onStatus) {
        // Try to init storage client
        var storage;
        try {
          var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
          storage = client.storage;
        } catch (e) {
          throw new Error('Supabase Storage not available');
        }

        var ext      = file.name.split('.').pop().toLowerCase() || 'mp4';
        var fileName = 'video-' + Date.now() + '.' + ext;
        onStatus('busy', '⏳ Uploading ' + file.name + '…');

        // Attempt upload (bucket must exist and have INSERT policy for anon)
        var uploadRes = await storage
          .from(STORAGE_BUCKET)
          .upload(fileName, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || 'video/mp4'
          });

        if (uploadRes.error) {
          // Common reason: bucket doesn't exist or RLS blocks anon upload
          throw new Error(uploadRes.error.message || 'Upload failed');
        }

        // Get the public URL
        var urlRes = storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
        var publicUrl = (urlRes.data && urlRes.data.publicUrl) ? urlRes.data.publicUrl : '';
        if (!publicUrl) throw new Error('Could not get public URL after upload');

        return publicUrl;
      }

      // ── Inject video upload enhancement into the admin portal ──────────
      var _patchedVideoField = false;

      function patchAdminVideoField() {
        if (_patchedVideoField) return;

        // Find the "Tutorial Video URL (direct link)" label
        var labels = document.querySelectorAll('label, span, div');
        var targetLabel = null;
        for (var i = 0; i < labels.length; i++) {
          var txt = labels[i].textContent || '';
          if (txt.trim() === 'Tutorial Video URL (direct link)' ||
              txt.trim().toLowerCase().indexOf('tutorial video url') !== -1) {
            targetLabel = labels[i];
            break;
          }
        }
        if (!targetLabel) return;

        // Walk up to find the container div that holds label + input
        var container = targetLabel.parentElement;
        if (!container) return;

        // Find the input inside this container
        var urlInput = container.querySelector('input[placeholder*="video.mp4"], input[placeholder*="video"]');
        if (!urlInput) {
          // Try sibling/child search
          urlInput = container.querySelector('input');
        }
        if (!urlInput) return;

        // Already patched?
        if (container.querySelector('.sf-vid-wrap')) return;
        _patchedVideoField = true;

        // ── Build the enhancement UI ──────────────────────────────────────
        // Wrap the existing input in a flex row alongside an upload button
        var wrap = document.createElement('div');
        wrap.className = 'sf-vid-wrap';

        var row = document.createElement('div');
        row.className = 'sf-vid-row';

        // Clone the original input style onto the row's input (React still
        // controls the original). We just re-parent the input visually.
        urlInput.parentNode.insertBefore(wrap, urlInput);
        wrap.appendChild(row);
        row.appendChild(urlInput);        // move input into row

        // Hidden file input
        var fileInput = document.createElement('input');
        fileInput.type   = 'file';
        fileInput.accept = 'video/mp4,video/webm,video/*,.mp4,.webm,.mov';
        fileInput.style.display = 'none';
        wrap.appendChild(fileInput);

        // Upload button
        var uploadBtn = document.createElement('button');
        uploadBtn.type      = 'button';
        uploadBtn.className = 'sf-vid-upload-btn';
        uploadBtn.innerHTML = '📁 Upload MP4';
        row.appendChild(uploadBtn);

        // Status line
        var statusEl = document.createElement('div');
        statusEl.className = 'sf-vid-status';
        statusEl.innerHTML = 'Or upload an MP4 directly to Supabase Storage';
        wrap.appendChild(statusEl);

        function setStatus(cls, msg) {
          statusEl.className = 'sf-vid-status ' + (cls || '');
          statusEl.textContent = msg;
        }

        // Click upload button → open file picker
        uploadBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          fileInput.click();
        });

        // File selected → upload
        fileInput.addEventListener('change', async function () {
          var file = fileInput.files && fileInput.files[0];
          if (!file) return;

          uploadBtn.disabled = true;
          uploadBtn.textContent = '⏳ Uploading…';

          try {
            var publicUrl = await uploadVideoFile(file, function (cls, msg) {
              setStatus(cls, msg);
            });
            setReactInputValue(urlInput, publicUrl);
            setStatus('ok', '✅ Uploaded! Auto-saving…');
            uploadBtn.innerHTML = '📁 Upload MP4';
            uploadBtn.disabled = false;

            // Auto-trigger the "Save" / "Save Global" button so the admin
            // doesn't need to manually click after a successful upload.
            setTimeout(function () {
              var saveBtns = document.querySelectorAll('button');
              var saveBtn = null;
              for (var sb = 0; sb < saveBtns.length; sb++) {
                var sbtxt = (saveBtns[sb].textContent || '').trim().toLowerCase();
                if (sbtxt === 'save global' || sbtxt === 'save' || sbtxt.indexOf('save') !== -1) {
                  saveBtn = saveBtns[sb];
                  break;
                }
              }
              if (saveBtn && !saveBtn.disabled) {
                saveBtn.click();
                setStatus('ok', '✅ Uploaded & saved! Video URL updated in database.');
              } else {
                setStatus('ok', '✅ Uploaded! URL filled — click "Save Global" to save.');
              }
            }, 600);
          } catch (err) {
            // Upload failed — show helpful guidance
            uploadBtn.innerHTML = '📁 Upload MP4';
            uploadBtn.disabled = false;

            var msg = err.message || 'Upload error';
            var hint = '';
            if (msg.toLowerCase().indexOf('not found') !== -1 ||
                msg.toLowerCase().indexOf('bucket') !== -1) {
              hint = ' — Bucket "' + STORAGE_BUCKET + '" missing. Create it in Supabase Storage > New bucket (public), then retry.';
            } else if (msg.toLowerCase().indexOf('row-level security') !== -1 ||
                       msg.toLowerCase().indexOf('policy') !== -1) {
              hint = ' — Add a Storage policy: allow anon INSERT on bucket "' + STORAGE_BUCKET + '".';
            }

            setStatus('err', '❌ ' + msg + hint);
          }

          // Reset file input so the same file can be re-selected if needed
          fileInput.value = '';
        });
      }

      // ── Watch for the admin portal to mount ────────────────────────────
      // Coalesced: one check after paint per burst of DOM changes, and
      // it disconnects itself once the field is patched so it stops
      // costing anything on later tab switches.
      var _adminObserver;
      var _scheduleAdminPatch = function () {
        patchAdminVideoField();
        if (_patchedVideoField && _adminObserver) _adminObserver.disconnect();
      };
      if (window.__sfCoalesce) _scheduleAdminPatch = window.__sfCoalesce(_scheduleAdminPatch);
      _adminObserver = new MutationObserver(_scheduleAdminPatch);
      _adminObserver.observe(document.body, { childList: true, subtree: true });

      // Also poll briefly at startup in case the portal is already rendered
      var _adminPollTimer = setInterval(function () {
        if (document.hidden) return;
        patchAdminVideoField();
        if (_patchedVideoField) clearInterval(_adminPollTimer);
      }, 1000);
      setTimeout(function () { clearInterval(_adminPollTimer); }, 30000);

  /* ── 4) /api/services interception ─────────────────────────────
     Captures the secondary offer URL and publishes it globally so
     earn.js can render its Choice 2 card. We wrap after
     supabase-api.js wraps, so this wrapper runs first;
     chain: this wrapper -> supabase-api wrapper -> _realFetch. */
  var _originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
    var result = await _originalFetch(input, init);

    if (url === '/api/services') {
      try {
        var clone = result.clone();
        clone.json().then(function (data) {
          if (data && data.cpaLeadUrl) window.__sfCpaLeadUrl = data.cpaLeadUrl;
        }).catch(function () {});
      } catch (e) {}
    }

    return result;
  };
}());
