/* Signalpost dashboard: progressive enhancements shared by all pages.
   No inline scripts are used (strict CSP). */
(function () {
  'use strict';

  // Mobile navigation.
  var toggle = document.querySelector('[data-menu-toggle]');
  var sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', function () {
      var open = sidebar.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  // Workspace switcher.
  var ws = document.querySelector('[data-ws-switch] select');
  if (ws) {
    ws.addEventListener('change', function () {
      if (/^[0-9]+$/.test(ws.value)) { window.location.href = '/w/' + ws.value; }
    });
  }

  // Confirmation for destructive forms.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) { e.preventDefault(); }
    });
  });

  // Confirmation for a single destructive button within a form.
  document.querySelectorAll('[data-confirm-click]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      if (!window.confirm(btn.getAttribute('data-confirm-click'))) { e.preventDefault(); }
    });
  });

  // Auto-submit selects (e.g. role changes).
  document.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form.submit(); });
  });

  // Copy buttons.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = btn.parentNode.querySelector('[data-copy-source]');
      if (!src) { return; }
      var text = src.value !== undefined ? src.value : src.textContent;
      var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard) { navigator.clipboard.writeText(text).then(done); } else { src.select(); document.execCommand('copy'); done(); }
    });
  });

  // ---- Installable app (PWA) -------------------------------------------------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* app still works without it */ });
  }
  var installBtn = document.querySelector('[data-install-app]');
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) { installBtn.hidden = false; }
  });
  if (installBtn) {
    installBtn.addEventListener('click', function () {
      if (!deferredPrompt) { return; }
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () { deferredPrompt = null; installBtn.hidden = true; });
    });
  }

  // ---- Push notifications (Account page) -------------------------------------
  var pushBox = document.querySelector('[data-push]');
  if (pushBox) {
    var statusEl = pushBox.querySelector('[data-push-status]');
    var enableBtn = pushBox.querySelector('[data-push-enable]');
    var testBtn = pushBox.querySelector('[data-push-test]');
    var disableBtn = pushBox.querySelector('[data-push-disable]');
    var csrf = pushBox.getAttribute('data-csrf');
    var say = function (t) { statusEl.textContent = t; };
    var api = function (method, path, body) {
      return fetch(path, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': csrf }, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) { throw new Error((j.error && j.error.message) || 'Request failed'); } return j.data; }); });
    };
    var keyBytes = function (b64) {
      var s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
      var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) { a[i] = s.charCodeAt(i); } return a;
    };
    var refresh = function () {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) {
        say('This browser does not support push notifications here. On iPhone/iPad, install the app to the Home Screen first. Notifications also require HTTPS.');
        return;
      }
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        enableBtn.hidden = !!sub; testBtn.hidden = !sub; disableBtn.hidden = !sub;
        say(sub ? 'Notifications are on for this device.' : (Notification.permission === 'denied' ? 'Notifications are blocked in this browser\'s site settings.' : 'Notifications are off for this device.'));
      });
    };
    enableBtn.addEventListener('click', function () {
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { say('Permission was not granted.'); return; }
        return api('GET', '/api/v1/push/key').then(function (d) {
          return navigator.serviceWorker.ready.then(function (reg) {
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(d.public_key) });
          });
        }).then(function (sub) { return api('POST', '/api/v1/push/subscriptions', sub.toJSON()); }).then(refresh);
      }).catch(function (e) { say('Could not enable notifications: ' + e.message); });
    });
    testBtn.addEventListener('click', function () {
      api('POST', '/api/v1/push/test').then(function (d) { say(d.delivered ? 'Test sent — it should arrive in a few seconds.' : 'The push service did not accept the test. Try turning notifications off and on.'); }, function (e) { say(e.message); });
    });
    disableBtn.addEventListener('click', function () {
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (!sub) { return; }
        return api('POST', '/api/v1/push/subscriptions/delete', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
      }).then(refresh).catch(function (e) { say(e.message); });
    });
    refresh();
  }

  // Show UTC timestamps in the viewer's local time.
  window.SignalpostFormatTime = function (iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var sameDay = new Date().toDateString() === d.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                   : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  document.querySelectorAll('time[data-local]').forEach(function (t) {
    var s = window.SignalpostFormatTime(t.getAttribute('datetime'));
    if (s) { t.title = t.textContent; t.textContent = s; }
  });
})();
