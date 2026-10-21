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
