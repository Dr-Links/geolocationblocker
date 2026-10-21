/*!
 * Signalpost chat widget v1
 * Loaded by the Signalpost Connector WordPress plugin. Configuration comes from
 * window.SignalpostConfig (no secrets). Renders inside a Shadow DOM so site
 * themes and page builders cannot affect it. All message text is inserted with
 * textContent — never as HTML.
 */
(function () {
  'use strict';

  var cfg = window.SignalpostConfig;
  if (!cfg || !cfg.apiBase || !/^[0-9a-f]{32}$/.test(cfg.siteKey || '') || window.Signalpost) { return; }

  var W = cfg.widget || {};
  var T = cfg.tracking || {};
  var P = cfg.polling || {};
  var API = cfg.apiBase.replace(/\/+$/, '') + '/widget/' + cfg.siteKey;
  var STORE_KEY = 'signalpost:v1:' + cfg.siteKey;
  var TOKEN_MAX_IDLE_MS = 180 * 24 * 3600 * 1000;
  var POLL_ACTIVE = clamp(P.widget_active_ms || 4000, 2000, 60000);
  var POLL_IDLE = clamp(P.widget_idle_ms || 15000, 5000, 120000);
  var POLL_HIDDEN = clamp(P.widget_hidden_ms || 30000, 10000, 300000);
  var MAX_BACKOFF = clamp(P.max_backoff_ms || 60000, 10000, 600000);

  function clamp(v, lo, hi) { v = Number(v) || lo; return Math.max(lo, Math.min(hi, v)); }

  // ---------------------------------------------------------------- storage
  // First-party localStorage on the website's own origin. Failures (private mode,
  // blocked storage) degrade to an in-memory session.
  var memoryStore = {};
  function load() {
    try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return memoryStore; }
  }
  function save(data) {
    memoryStore = data;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* memory only */ }
  }
  function patch(changes) { var d = load(); for (var k in changes) { if (Object.prototype.hasOwnProperty.call(changes, k)) { d[k] = changes[k]; } } save(d); return d; }

  var stored = load();
  if (stored.t && stored.used && Date.now() - stored.used > TOKEN_MAX_IDLE_MS) {
    stored = patch({ t: null, used: null }); // Expire idle identifiers.
  }

  function randomId(bytes) {
    var a = new Uint8Array(bytes);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ---------------------------------------------------------------- state
  var state = {
    token: stored.t || null,
    session: null,          // last /session payload
    open: false,
    messages: [],           // {id, sender, author, body, created_at, client_id, status}
    lastId: 0,
    conversation: null,
    available: true,
    pollTimer: null,
    failures: 0,
    unread: 0,
    analyticsPermitted: false,
    pageViewSent: false,
    connecting: null
  };

  // ---------------------------------------------------------------- http
  function api(method, path, body) {
    var headers = { 'Accept': 'application/json' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; }
    if (state.token) { headers['X-Visitor-Token'] = state.token; }
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      keepalive: method !== 'GET' && path === '/events'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok || !json || json.ok !== true) {
          var err = new Error((json && json.error && json.error.message) || 'Request failed');
          err.status = res.status;
          err.code = json && json.error && json.error.code;
          throw err;
        }
        return json.data;
      });
    });
  }

  /** Creates or resumes the visitor session. Only called after visitor interaction or permitted analytics. */
  function ensureSession() {
    if (state.session) { return Promise.resolve(state.session); }
    if (state.connecting) { return state.connecting; }
    state.connecting = api('POST', '/session', {}).then(function (data) {
      if (data.token) { state.token = data.token; }
      patch({ t: state.token, used: Date.now() });
      applySession(data);
      return data;
    }, function (err) {
      if (err.status === 401) { forgetIdentity(); }
      throw err;
    }).then(function (d) { state.connecting = null; return d; }, function (e) { state.connecting = null; throw e; });
    return state.connecting;
  }

  function forgetIdentity() {
    state.token = null; state.session = null; state.messages = []; state.lastId = 0;
    patch({ t: null, used: null });
  }

  function applySession(data) {
    state.session = data;
    state.available = !!(data.chat && data.chat.available);
    state.conversation = data.chat ? data.chat.conversation : null;
    state.messages = [];
    state.lastId = 0;
    mergeMessages((data.chat && data.chat.messages) || []);
    state.analyticsPermitted = !!(data.analytics && data.analytics.permitted);
    render();
    maybeTrackPageView();
    schedulePoll(0);
  }

  // ---------------------------------------------------------------- polling
  function pollInterval() {
    if (document.hidden) { return POLL_HIDDEN; }
    return state.open ? POLL_ACTIVE : POLL_IDLE;
  }

  function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    // No identity or no conversation and panel closed: no polling at all.
    if (!state.token || !state.session || (!state.conversation && !state.open)) { return; }
    var wait = delay !== undefined ? delay : pollInterval();
    if (state.failures > 0) { wait = Math.min(MAX_BACKOFF, pollInterval() * Math.pow(2, state.failures)) * (0.8 + Math.random() * 0.4); }
    state.pollTimer = setTimeout(poll, wait);
  }

  function poll() {
    api('GET', '/messages?after=' + state.lastId).then(function (data) {
      state.failures = 0;
      setConnection(true);
      state.conversation = data.conversation;
      state.available = data.chat_available !== false;
      var before = state.lastId;
      mergeMessages(data.messages || []);
      if (!state.open) {
        (data.messages || []).forEach(function (m) { if (m.sender !== 'visitor' && m.id > before) { state.unread++; } });
      }
      render();
      schedulePoll();
    }, function (err) {
      if (err.status === 401) { forgetIdentity(); render(); return; }
      if (err.status === 404) { teardown(); return; } // Website disconnected or widget disabled.
      state.failures = Math.min(state.failures + 1, 8);
      setConnection(false);
      schedulePoll();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.session) { schedulePoll(0); }
  });
  window.addEventListener('online', function () { state.failures = 0; if (state.session) { schedulePoll(0); } });

  function mergeMessages(list) {
    list.forEach(function (m) {
      var existing = null;
      for (var i = 0; i < state.messages.length; i++) {
        var x = state.messages[i];
        if (x.id === m.id || (m.client_id && x.client_id === m.client_id && x.sender === 'visitor')) { existing = x; break; }
      }
      if (existing) {
        existing.id = m.id; existing.status = 'sent'; existing.created_at = m.created_at;
      } else {
        state.messages.push({ id: m.id, sender: m.sender, author: m.author, body: String(m.body), created_at: m.created_at, client_id: m.client_id, status: 'sent' });
      }
      if (m.id > state.lastId) { state.lastId = m.id; }
    });
  }

  // ---------------------------------------------------------------- sending
  function send(text) {
    text = String(text || '').replace(/\s+$/, '');
    if (!text.trim()) { return; }
    var msg = { id: 0, sender: 'visitor', body: text, client_id: randomId(12), created_at: new Date().toISOString(), status: 'pending' };
    state.messages.push(msg);
    render(true);
    deliver(msg);
  }

  function deliver(msg) {
    msg.status = 'pending';
    render(true);
    ensureSession().then(function () {
      return api('POST', '/messages', { client_message_id: msg.client_id, body: msg.body });
    }).then(function (data) {
      msg.status = 'sent';
      msg.id = data.message.id;
      msg.created_at = data.message.created_at;
      if (msg.id > state.lastId) { state.lastId = msg.id; }
      if (!state.conversation) { state.conversation = { status: 'open', read_only: false }; }
      state.conversation.status = 'open';
      setConnection(true);
      render(true);
      schedulePoll(1500);
    }, function (err) {
      msg.status = 'failed';
      if (err.code === 'chat_unavailable') { state.available = false; }
      if (err.code === 'prechat_required') { state.forceForm = true; }
      msg.error = err.status === 422 ? err.message : null;
      render(true);
    });
  }

  // ---------------------------------------------------------------- analytics (optional)
  // Nothing in this section runs unless the website enables analytics AND the
  // visitor's permission is established. The server checks again and fails closed.
  function localConsent() {
    var c = load().consent;
    return c && c.v === String(T.policyVersion) ? c.analytics : null; // true | false | null (unknown)
  }

  function maybeTrackPageView() {
    if (!T.analyticsEnabled || T.pageExcluded || state.pageViewSent || !state.analyticsPermitted) { return; }
    if (isExcluded(location.pathname)) { return; }
    state.pageViewSent = true;
    var ev = { type: 'page_view', uid: randomId(12), path: location.pathname, ts: Date.now() };
    if (T.recordTitles) { ev.title = String(document.title || '').slice(0, 200); }
    if (T.recordReferrer && document.referrer) {
      try { var r = new URL(document.referrer); if (r.origin !== location.origin) { ev.referrer = r.origin; } } catch (e) { /* ignore */ }
    }
    api('POST', '/events', { events: [ev] }).catch(function () { /* analytics are best-effort */ });
  }

  function isExcluded(path) {
    path = '/' + String(path).replace(/^\/+/, '').toLowerCase();
    return (T.excludedPaths || []).some(function (p) {
      p = String(p).toLowerCase();
      return p === '/' || path === p || path.indexOf(p.replace(/\/$/, '') + '/') === 0 || (/\.php$/.test(p) && path.indexOf(p) === 0);
    });
  }

  function setAnalyticsConsent(allowed, source) {
    allowed = !!allowed;
    source = source === 'wp_consent_api' || source === 'custom' ? source : 'widget';
    var previous = localConsent();
    patch({ consent: { v: String(T.policyVersion), analytics: allowed } });
    hideConsentPrompt();
    if (!T.analyticsEnabled) { return; }
    if (!allowed) {
      state.analyticsPermitted = false;
      // Record a withdrawal (or objection) centrally only if an identity already exists.
      if (state.token && (previous === true || T.legalBasis === 'other')) {
        ensureSession().then(function () { return api('POST', '/consent', { analytics: false, source: source }); }).catch(function () {});
      }
      render();
      return;
    }
    ensureSession().then(function () {
      return api('POST', '/consent', { analytics: true, source: source });
    }).then(function (d) {
      state.analyticsPermitted = !!d.analytics_permitted;
      maybeTrackPageView();
      render();
    }).catch(function () { state.analyticsPermitted = false; });
  }

  function initAnalytics() {
    if (!T.analyticsEnabled) { return; }
    var c = localConsent();
    if (T.legalBasis === 'other') {
      if (c !== false) { ensureSession().catch(function () {}); } // Server decides; objection honoured.
      return;
    }
    if (T.consentSource === 'widget' && c === null) { showConsentPrompt(); return; }
    if (c === true) { ensureSession().catch(function () {}); }
    // wp_consent_api / custom: wait for setAnalyticsConsent() from the site's consent tool.
  }

  // ---------------------------------------------------------------- DOM
  var host = document.createElement('div');
  host.id = 'signalpost-chat';
  host.setAttribute('data-signalpost', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var el = {};

  function h(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k) || attrs[k] === null || attrs[k] === undefined) { continue; }
        if (k === 'text') { n.textContent = attrs[k]; } else if (k === 'on') {
          for (var ev in attrs.on) { if (Object.prototype.hasOwnProperty.call(attrs.on, ev)) { n.addEventListener(ev, attrs.on[ev]); } }
        } else { n.setAttribute(k, attrs[k]); }
      }
    }
    (children || []).forEach(function (c) { if (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return n;
  }

  function svg(path) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    var p = document.createElementNS(ns, 'path'); p.setAttribute('d', path); s.appendChild(p);
    return s;
  }

  var ICON_CHAT = 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
  var ICON_CLOSE = 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z';
  var ICON_SEND = 'M3 20.5 21 12 3 3.5v6.6l12 1.9-12 1.9z';

  function build() {
    var color = /^#[0-9a-f]{6}$/i.test(W.primary_color || '') ? W.primary_color : '#155254';
    host.style.setProperty('--sp-color', color);
    host.style.setProperty('--sp-offset', clamp(W.offset_px === undefined ? 20 : W.offset_px, 0, 80) + 'px');

    if (cfg.styleUrl) { root.appendChild(h('link', { rel: 'stylesheet', href: cfg.styleUrl })); }
    var wrap = h('div', { 'class': 'sp ' + (W.position === 'left' ? 'sp-left' : 'sp-right'), part: 'root' });

    el.badge = h('span', { 'class': 'sp-badge', hidden: '', 'aria-hidden': 'true' });
    el.launcher = h('button', { type: 'button', 'class': 'sp-launcher', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'sp-panel', 'aria-label': W.launcher_label || 'Chat with us', title: W.launcher_label || 'Chat with us', on: { click: toggle } }, [svg(ICON_CHAT), el.badge]);

    el.title = h('h2', { 'class': 'sp-title', id: 'sp-title', text: W.brand_name || W.launcher_label || 'Chat' });
    el.close = h('button', { type: 'button', 'class': 'sp-icon-btn', 'aria-label': 'Close chat', on: { click: close } }, [svg(ICON_CLOSE)]);
    el.status = h('div', { 'class': 'sp-status', role: 'status', 'aria-live': 'polite' });

    el.welcome = h('div', { 'class': 'sp-welcome' }, [
      h('p', { 'class': 'sp-greeting', text: W.greeting_title || 'Hi there!' }),
      W.welcome_message ? h('p', { 'class': 'sp-welcome-text', text: W.welcome_message }) : null
    ]);
    el.list = h('ol', { 'class': 'sp-messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Messages' });
    el.form = buildPrechat();
    el.notice = h('p', { 'class': 'sp-notice', hidden: '' });
    el.input = h('textarea', { 'class': 'sp-input', rows: '1', maxlength: '4000', 'aria-label': 'Type your message', placeholder: 'Type your message…',
      on: { keydown: function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); } }, input: autosize } });
    el.sendBtn = h('button', { type: 'submit', 'class': 'sp-send', 'aria-label': 'Send message' }, [svg(ICON_SEND)]);
    el.composer = h('form', { 'class': 'sp-composer', on: { submit: function (e) { e.preventDefault(); submitComposer(); } } }, [el.input, el.sendBtn]);
    el.consentBox = buildConsentInPanel();

    el.panel = h('div', { 'class': 'sp-panel', id: 'sp-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'sp-title', hidden: '',
      on: { keydown: function (e) { if (e.key === 'Escape') { close(); } } } }, [
      h('header', { 'class': 'sp-header' }, [el.title, el.close]),
      el.status,
      h('div', { 'class': 'sp-body' }, [el.welcome, el.list, el.form]),
      el.notice,
      el.composer,
      el.consentBox,
      W.show_branding !== false ? h('p', { 'class': 'sp-brand', text: 'Powered by Signalpost' }) : null
    ]);

    el.prompt = h('div', { 'class': 'sp-prompt', role: 'region', 'aria-label': 'Analytics choice', hidden: '' }, [
      h('p', { text: 'May we record which pages you view on this site to help us support you? Chat works either way.' }),
      h('div', { 'class': 'sp-prompt-actions' }, [
        h('button', { type: 'button', 'class': 'sp-btn sp-btn-primary', text: 'Allow', on: { click: function () { setAnalyticsConsent(true, 'widget'); } } }),
        h('button', { type: 'button', 'class': 'sp-btn', text: 'No thanks', on: { click: function () { setAnalyticsConsent(false, 'widget'); } } })
      ])
    ]);

    wrap.appendChild(el.prompt);
    wrap.appendChild(el.panel);
    wrap.appendChild(el.launcher);
    root.appendChild(wrap);
    document.body.appendChild(host);
  }

  function buildPrechat() {
    var fields = [['name', 'Name', 'text', 'name'], ['email', 'Email', 'email', 'email'], ['phone', 'Phone', 'tel', 'tel']];
    var form = h('form', { 'class': 'sp-prechat', hidden: '', novalidate: '', on: { submit: submitPrechat } });
    form.appendChild(h('p', { 'class': 'sp-prechat-intro', text: 'Before we start, tell us a little about you.' }));
    el.fieldInputs = {};
    fields.forEach(function (f) {
      var mode = W['prechat_' + f[0]];
      if (mode !== 'optional' && mode !== 'required') { return; }
      var id = 'sp-f-' + f[0];
      var input = h('input', { id: id, name: f[0], type: f[2], autocomplete: f[3], maxlength: f[0] === 'email' ? '254' : (f[0] === 'phone' ? '32' : '100'), required: mode === 'required' ? '' : null });
      el.fieldInputs[f[0]] = input;
      form.appendChild(h('label', { 'for': id, 'class': 'sp-label' }, [f[1] + (mode === 'required' ? '' : ' (optional)')]));
      form.appendChild(input);
    });
    el.formError = h('p', { 'class': 'sp-error', role: 'alert', hidden: '' });
    form.appendChild(el.formError);
    if (W.prechat_notice) { form.appendChild(h('p', { 'class': 'sp-small', text: W.prechat_notice })); }
    var actions = h('div', { 'class': 'sp-prompt-actions' }, [h('button', { type: 'submit', 'class': 'sp-btn sp-btn-primary', text: 'Continue' })]);
    el.skip = h('button', { type: 'button', 'class': 'sp-btn', text: 'Skip', on: { click: function () { state.formDismissed = true; render(); } } });
    actions.appendChild(el.skip);
    form.appendChild(actions);
    return form;
  }

  function buildConsentInPanel() {
    if (!T.analyticsEnabled) { return null; }
    el.consentLabel = h('span', { 'class': 'sp-small' });
    el.consentToggle = h('button', { type: 'button', 'class': 'sp-link', on: { click: function () {
      var allowed = T.legalBasis === 'other' ? localConsent() !== false : localConsent() === true;
      setAnalyticsConsent(!allowed, 'widget');
    } } });
    return h('div', { 'class': 'sp-consent' }, [el.consentLabel, ' ', el.consentToggle]);
  }

  function prechatNeeded() {
    var fieldsOn = el.fieldInputs && Object.keys(el.fieldInputs).length > 0;
    if (!fieldsOn) { return false; }
    var pc = state.session && state.session.chat && state.session.chat.prechat;
    if (pc && pc.missing_required && pc.missing_required.length) { return true; }
    if (state.forceForm) { return true; }
    if (state.formDismissed || (pc && pc.submitted) || state.messages.length) { return false; }
    return !state.session || !pc || !pc.submitted;
  }

  function submitPrechat(e) {
    e.preventDefault();
    var body = {};
    Object.keys(el.fieldInputs).forEach(function (k) { var v = el.fieldInputs[k].value.trim(); if (v) { body[k] = v; } });
    el.formError.hidden = true;
    ensureSession().then(function () { return api('POST', '/contact', body); }).then(function () {
      if (state.session && state.session.chat) { state.session.chat.prechat.missing_required = []; state.session.chat.prechat.submitted = true; }
      state.forceForm = false;
      render();
      el.input.focus();
    }, function (err) {
      el.formError.textContent = err.status === 422 ? 'Please check the highlighted details and try again.' : 'We could not save your details. Please try again.';
      el.formError.hidden = false;
    });
  }

  function submitComposer() {
    if (!state.available || (state.conversation && state.conversation.read_only)) { return; }
    var v = el.input.value;
    if (!v.trim()) { return; }
    el.input.value = '';
    autosize();
    send(v);
  }

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
  }

  function setConnection(ok) {
    el.status.textContent = ok ? '' : 'Connection problem — retrying…';
    el.status.className = 'sp-status' + (ok ? '' : ' sp-status-warn');
  }

  function formatTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function render(scroll) {
    if (!el.panel) { return; }
    var showForm = state.open && prechatNeeded();
    el.form.hidden = !showForm;
    if (el.skip) { el.skip.hidden = !!(state.session && state.session.chat && state.session.chat.prechat.missing_required.length) || Object.keys(el.fieldInputs).some(function (k) { return W['prechat_' + k] === 'required'; }); }
    el.welcome.hidden = state.messages.length > 0;
    el.list.hidden = state.messages.length === 0;

    // Rebuild the list (bounded size); all bodies via textContent.
    while (el.list.firstChild) { el.list.removeChild(el.list.firstChild); }
    state.messages.slice(-200).forEach(function (m) {
      var who = m.sender === 'visitor' ? 'You' : (m.sender === 'operator' ? (m.author || 'Support') : 'System');
      var meta = h('span', { 'class': 'sp-meta' });
      meta.textContent = who + ' · ' + (m.status === 'pending' ? 'Sending…' : m.status === 'failed' ? 'Not sent' : formatTime(m.created_at));
      var item = h('li', { 'class': 'sp-msg sp-msg-' + m.sender + (m.status !== 'sent' ? ' sp-msg-' + m.status : '') }, [
        h('span', { 'class': 'sp-sr', text: who + ' said: ' }),
        h('span', { 'class': 'sp-text', text: m.body }),
        meta
      ]);
      if (m.status === 'failed') {
        if (m.error) { item.appendChild(h('span', { 'class': 'sp-error', text: m.error })); }
        if (state.available) {
          item.appendChild(h('button', { type: 'button', 'class': 'sp-link', text: 'Retry', on: { click: function () { deliver(m); } } }));
        }
      }
      el.list.appendChild(item);
    });

    var readOnly = state.conversation && state.conversation.read_only;
    var blocked = !state.available || readOnly;
    el.notice.hidden = !blocked && !(state.conversation && state.conversation.status === 'closed');
    el.notice.textContent = blocked ? 'Chat is not available right now.' : 'This conversation was closed. Send a message to continue.';
    el.composer.hidden = showForm || blocked;
    el.input.disabled = blocked;

    if (el.consentBox) {
      var allowed = T.legalBasis === 'other' ? localConsent() !== false : localConsent() === true;
      el.consentLabel.textContent = allowed ? 'Page-view analytics: allowed.' : 'Page-view analytics: off.';
      el.consentToggle.textContent = allowed ? 'Turn off' : 'Allow';
      el.consentBox.hidden = T.consentSource !== 'widget' && T.legalBasis !== 'other';
    }

    el.badge.hidden = state.unread === 0 || state.open;
    el.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    el.launcher.setAttribute('aria-label', (W.launcher_label || 'Chat with us') + (state.unread && !state.open ? ' (' + state.unread + ' new)' : ''));
    if (scroll || state.open) { el.list.scrollTop = el.list.scrollHeight; }
  }

  function showConsentPrompt() { if (el.prompt) { el.prompt.hidden = false; } }
  function hideConsentPrompt() { if (el.prompt) { el.prompt.hidden = true; } }

  function open() {
    if (state.open) { return; }
    state.open = true;
    state.unread = 0;
    el.panel.hidden = false;
    el.launcher.setAttribute('aria-expanded', 'true');
    host.classList.add('sp-is-open');
    render(true);
    ensureSession().then(function () { render(true); schedulePoll(0); }, function (err) {
      if (err.status === 404) { el.notice.hidden = false; el.notice.textContent = 'Chat is not available right now.'; el.composer.hidden = true; return; }
      setConnection(false);
    });
    setTimeout(function () { (prechatNeeded() ? el.form.querySelector('input') : el.input || el.close).focus(); }, 30);
  }

  function close() {
    if (!state.open) { return; }
    state.open = false;
    el.panel.hidden = true;
    el.launcher.setAttribute('aria-expanded', 'false');
    host.classList.remove('sp-is-open');
    el.launcher.focus();
    schedulePoll();
  }

  function toggle() { if (state.open) { close(); } else { open(); } }

  function teardown() {
    clearTimeout(state.pollTimer);
    if (host.parentNode) { host.parentNode.removeChild(host); }
  }

  function start() {
    build();
    render();
    if (state.token) { ensureSession().catch(function () {}); } // Returning chat visitor: restore conversation.
    initAnalytics();
    window.Signalpost = {
      open: open,
      close: close,
      setAnalyticsConsent: setAnalyticsConsent,
      version: '1.0.0'
    };
    try { window.dispatchEvent(new CustomEvent('signalpost:ready')); } catch (e) { /* old browsers */ }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', start); } else { start(); }
})();
