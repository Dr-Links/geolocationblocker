/* Signalpost inbox: conversation list, thread, replies and visitor panel.
   Short polling with incremental cursors, backoff and reduced polling in hidden tabs.
   Every piece of user-provided text is inserted with textContent. */
(function () {
  'use strict';

  var root = document.getElementById('inbox');
  if (!root) { return; }

  var WS = root.getAttribute('data-ws');
  var CSRF = root.getAttribute('data-csrf');
  var POLL_MS = Math.max(2000, parseInt(root.getAttribute('data-poll-ms'), 10) || 5000);
  var MAX_BACKOFF = Math.max(10000, parseInt(root.getAttribute('data-max-backoff-ms'), 10) || 60000);
  var CAN_REPLY = root.getAttribute('data-can-reply') === '1';
  var CAN_UPDATE = root.getAttribute('data-can-update') === '1';
  var BASE = '/api/v1/dashboard/w/' + WS;
  // Resolved lazily: app.js (which defines the formatter) may run after this script.
  function fmt(s) { return window.SignalpostFormatTime ? window.SignalpostFormatTime(s) : String(s || ''); }

  var q = function (sel) { return root.querySelector(sel); };
  var ui = {
    filters: q('[data-filters]'), list: q('[data-list]'), listState: q('[data-list-state]'),
    moreWrap: q('[data-more-wrap]'), more: q('[data-more]'), thread: q('[data-thread]'),
    empty: q('[data-thread-empty]'), head: q('[data-thread-head]'), title: q('[data-thread-title]'),
    status: q('[data-thread-status]'), setStatus: q('[data-set-status]'), messages: q('[data-messages]'),
    composer: q('[data-composer]'), readonly: q('[data-readonly]'), profile: q('[data-profile]'),
    back: q('[data-back]'), profileToggle: q('[data-profile-toggle]')
  };
  var textarea = ui.composer.querySelector('textarea');

  var state = {
    items: {}, order: [], nextBefore: null, maxSeen: 0,
    current: null, messages: [], lastMsgId: 0,
    failures: 0, timer: null, loading: false
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = String(text); }
    return n;
  }

  function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json', 'X-CSRF-Token': CSRF } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(BASE + path, opts).then(function (res) {
      if (res.status === 401) { window.location.href = '/login'; throw new Error('signed out'); }
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok || !json.ok) {
          var e = new Error((json.error && json.error.message) || 'Request failed (' + res.status + ')');
          e.status = res.status; throw e;
        }
        return json.data;
      });
    });
  }

  function filterParams() {
    var f = new FormData(ui.filters);
    var p = [];
    ['q', 'status', 'website'].forEach(function (k) { var v = f.get(k); if (v) { p.push(k + '=' + encodeURIComponent(v)); } });
    if (f.get('unread')) { p.push('unread=1'); }
    return p;
  }

  // ------------------------------------------------------------ list
  function loadList(reset) {
    if (reset) { state.items = {}; state.order = []; state.nextBefore = null; state.maxSeen = 0; ui.list.textContent = ''; }
    ui.listState.hidden = false;
    ui.listState.className = 'state';
    ui.listState.textContent = 'Loading conversations…';
    var params = filterParams();
    if (!reset && state.nextBefore) { params.push('before=' + state.nextBefore); }
    return request('GET', '/conversations?' + params.join('&')).then(function (data) {
      data.items.forEach(upsert);
      state.nextBefore = data.next_before;
      ui.moreWrap.hidden = !data.next_before;
      renderList();
    }, function (e) {
      ui.listState.hidden = false;
      ui.listState.className = 'state state-error';
      ui.listState.textContent = 'Could not load conversations. ' + e.message + ' ';
      var retry = el('button', 'btn btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { loadList(true); });
      ui.listState.appendChild(retry);
    });
  }

  function upsert(item) {
    if (!state.items[item.id]) { state.order.push(item.id); }
    state.items[item.id] = item;
    if (item.last_message_id > state.maxSeen) { state.maxSeen = item.last_message_id; }
  }

  function renderList() {
    state.order.sort(function (a, b) { return state.items[b].last_message_id - state.items[a].last_message_id; });
    ui.list.textContent = '';
    state.order.forEach(function (id) {
      var c = state.items[id];
      var li = el('li');
      var btn = el('button', 'conv');
      btn.type = 'button';
      if (state.current === id) { btn.setAttribute('aria-current', 'true'); }
      var top = el('div', 'conv-top');
      var name = el('span', 'conv-name', c.visitor.name || ('Visitor ' + c.visitor.public_id.slice(0, 8)));
      top.appendChild(name);
      if (c.unread) { var dot = el('span', 'unread-dot'); dot.setAttribute('aria-label', 'Unread'); dot.setAttribute('role', 'img'); top.appendChild(dot); }
      btn.appendChild(top);
      var preview = el('div', 'muted small', (c.last_sender === 'operator' ? 'You: ' : '') + (c.preview || ''));
      preview.style.overflow = 'hidden'; preview.style.textOverflow = 'ellipsis'; preview.style.whiteSpace = 'nowrap';
      btn.appendChild(preview);
      var meta = el('div', 'conv-meta');
      meta.appendChild(el('span', 'pill pill-' + c.status, c.status));
      meta.appendChild(el('span', null, c.website.name));
      meta.appendChild(el('span', null, fmt(c.last_message_at)));
      btn.appendChild(meta);
      btn.addEventListener('click', function () { openConversation(id); });
      li.appendChild(btn);
      ui.list.appendChild(li);
    });
    ui.listState.hidden = state.order.length > 0;
    if (!state.order.length) { ui.listState.className = 'state'; ui.listState.textContent = filterParams().length ? 'No conversations match these filters.' : 'No conversations yet. They appear when a visitor writes from a connected website.'; }
  }

  // ------------------------------------------------------------ thread
  function openConversation(id) {
    state.current = id;
    state.messages = [];
    state.lastMsgId = 0;
    renderList();
    root.classList.add('show-thread');
    ui.empty.hidden = false;
    ui.empty.className = 'state';
    ui.empty.textContent = 'Loading conversation…';
    ui.head.hidden = true; ui.messages.hidden = true; ui.composer.hidden = true; ui.readonly.hidden = true;
    try { history.replaceState(null, '', '?c=' + id); } catch (e) { /* ignore */ }
    request('GET', '/conversations/' + id).then(function (data) {
      if (state.current !== id) { return; }
      ui.empty.hidden = true;
      ui.head.hidden = false;
      ui.messages.hidden = false;
      var v = data.visitor;
      ui.title.textContent = (v.submitted.name || ('Visitor ' + v.public_id.slice(0, 8))) + ' · ' + v.website;
      setThreadStatus(data.conversation.status, data.conversation.read_only);
      ui.messages.textContent = '';
      appendMessages(data.messages);
      renderProfile(data.visitor);
      markRead();
      if (textarea && !ui.composer.hidden) { textarea.focus(); }
    }, function (e) {
      ui.empty.className = 'state state-error';
      ui.empty.textContent = e.status === 404 ? 'This conversation is not available.' : 'Could not load the conversation. ' + e.message;
    });
  }

  function setThreadStatus(status, readOnly) {
    ui.status.className = 'pill pill-' + status;
    ui.status.textContent = status + (readOnly ? ' · read-only' : '');
    ui.setStatus.hidden = !CAN_UPDATE;
    ui.setStatus.value = status;
    ui.composer.hidden = !CAN_REPLY;
    ui.readonly.hidden = CAN_REPLY && !readOnly;
    ui.readonly.textContent = !CAN_REPLY ? 'You have read-only access to this workspace.' : 'The visitor is blocked; they cannot reply in this conversation.';
    if (state.items[state.current]) { state.items[state.current].status = status; }
  }

  function appendMessages(list) {
    var atBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 60;
    list.forEach(function (m) {
      var pending = null;
      state.messages.forEach(function (x) { if (x.client_id === m.client_id && x.node && m.sender === 'operator' && x.pending) { pending = x; } });
      if (pending) { pending.pending = false; pending.id = m.id; renderMessage(pending, m); return; }
      if (state.messages.some(function (x) { return x.id === m.id; })) { return; }
      var item = { id: m.id, client_id: m.client_id };
      state.messages.push(item);
      item.node = el('div');
      renderMessage(item, m);
      ui.messages.appendChild(item.node);
      if (m.id > state.lastMsgId) { state.lastMsgId = m.id; }
    });
    if (atBottom || list.length) { ui.messages.scrollTop = ui.messages.scrollHeight; }
  }

  function renderMessage(item, m) {
    var n = item.node;
    n.className = 'msg msg-' + m.sender + (item.failed ? ' msg-failed' : '');
    n.textContent = '';
    n.appendChild(el('span', 'sr-only', (m.sender === 'visitor' ? 'Visitor' : (m.author || 'Operator')) + ': '));
    n.appendChild(document.createTextNode(m.body));
    var meta = el('span', 'msg-meta');
    var who = m.sender === 'operator' ? (m.author || 'You') : (m.sender === 'visitor' ? 'Visitor' : 'System');
    meta.textContent = who + ' · ' + (item.pending ? 'Sending…' : item.failed ? 'Failed to send' : fmt(m.created_at)) + (m.sender === 'operator' && m.delivered ? ' · delivered' : '');
    n.appendChild(meta);
    if (item.failed) {
      var retry = el('button', 'btn btn-sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { sendReply(item.body, item); });
      n.appendChild(retry);
    }
  }

  function randomId() {
    var a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function sendReply(text, existing) {
    var convId = state.current;
    var item = existing || { client_id: randomId(), body: text, node: el('div') };
    item.pending = true; item.failed = false;
    if (!existing) { state.messages.push(item); ui.messages.appendChild(item.node); }
    renderMessage(item, { sender: 'operator', body: text, author: 'You' });
    ui.messages.scrollTop = ui.messages.scrollHeight;
    request('POST', '/conversations/' + convId + '/messages', { client_message_id: item.client_id, body: text }).then(function (data) {
      item.pending = false; item.id = data.message.id;
      if (data.message.id > state.lastMsgId) { state.lastMsgId = data.message.id; }
      renderMessage(item, { sender: 'operator', body: text, author: 'You', created_at: data.message.created_at });
      if (state.items[convId]) { state.items[convId].last_message_id = data.message.id; state.items[convId].preview = text; state.items[convId].last_sender = 'operator'; state.items[convId].unread = false; }
      if (state.items[convId] && state.items[convId].status === 'closed') { setThreadStatus('open', false); }
      renderList();
    }, function (e) {
      item.pending = false; item.failed = true;
      renderMessage(item, { sender: 'operator', body: text, author: 'You' });
      item.node.appendChild(el('span', 'msg-meta', e.status === 422 ? e.message : ''));
    });
  }

  function markRead() {
    if (!state.current || !state.lastMsgId || !CAN_REPLY) { return; }
    var id = state.current;
    request('POST', '/conversations/' + id + '/read', { message_id: state.lastMsgId }).then(function () {
      if (state.items[id]) { state.items[id].unread = false; renderList(); }
    }, function () { /* non-critical */ });
  }

  // ------------------------------------------------------------ visitor panel
  function row(dl, label, value, kind) {
    dl.appendChild(el('dt', null, label));
    var dd = el('dd');
    if (value === null || value === undefined || value === '') {
      dd.appendChild(el('span', 'muted', kind === 'submitted' ? 'not provided' : 'unknown'));
    } else {
      dd.appendChild(document.createTextNode(String(value) + ' '));
      if (kind) { dd.appendChild(el('span', 'pill pill-' + kind, kind === 'inferred' ? 'estimated' : kind)); }
    }
    dl.appendChild(dd);
  }

  function renderProfile(v) {
    var p = ui.profile;
    p.textContent = '';
    var link = el('a', null, 'Open full profile');
    link.href = '/w/' + WS + '/visitors/' + v.id;
    p.appendChild(link);
    if (v.blocked) { p.appendChild(document.createTextNode(' ')); p.appendChild(el('span', 'pill pill-blocked', 'blocked')); }

    p.appendChild(el('h3', null, 'Submitted by visitor'));
    var dl1 = el('dl'); p.appendChild(dl1);
    row(dl1, 'Name', v.submitted.name, 'submitted');
    row(dl1, 'Email', v.submitted.email, 'submitted');
    row(dl1, 'Phone', v.submitted.phone, 'submitted');

    p.appendChild(el('h3', null, 'Observed'));
    var dl2 = el('dl'); p.appendChild(dl2);
    row(dl2, 'Visitor ID', v.public_id);
    row(dl2, 'Website', v.website);
    row(dl2, 'First seen', fmt(v.observed.first_seen_at));
    row(dl2, 'Last seen', fmt(v.observed.last_seen_at));
    row(dl2, 'Visits', v.observed.visit_count === null ? 'not tracked' : v.observed.visit_count);
    row(dl2, 'Last page', v.observed.last_page, v.observed.last_page ? 'observed' : null);
    row(dl2, 'Browser / OS', v.observed.browser ? v.observed.browser + ' / ' + v.observed.os : null, v.observed.browser ? 'observed' : null);

    p.appendChild(el('h3', null, 'Estimated'));
    var dl3 = el('dl'); p.appendChild(dl3);
    row(dl3, 'Country', v.inferred.country, v.inferred.country ? 'inferred' : null);

    p.appendChild(el('h3', null, 'Privacy'));
    var dl4 = el('dl'); p.appendChild(dl4);
    row(dl4, 'Tracking mode', v.consent.tracking_mode === 'analytics' ? 'Analytics (policy-gated)' : 'Essential chat only');
    row(dl4, 'Consent', v.consent.state);
    row(dl4, 'Analytics', v.consent.analytics_permitted ? 'permitted' : 'not permitted');
  }

  // ------------------------------------------------------------ polling
  function schedule(delay) {
    clearTimeout(state.timer);
    var wait = delay !== undefined ? delay : (document.hidden ? Math.max(POLL_MS * 4, 20000) : POLL_MS);
    if (state.failures) { wait = Math.min(MAX_BACKOFF, POLL_MS * Math.pow(2, state.failures)); }
    state.timer = setTimeout(tick, wait);
  }

  function tick() {
    var params = filterParams();
    params.push('since=' + state.maxSeen);
    var jobs = [request('GET', '/conversations?' + params.join('&')).then(function (data) {
      data.items.forEach(upsert);
      if (data.items.length) { renderList(); }
    })];
    if (state.current) {
      var id = state.current;
      jobs.push(request('GET', '/conversations/' + id + '/messages?after=' + state.lastMsgId).then(function (data) {
        if (state.current !== id) { return; }
        if (data.messages.length) { appendMessages(data.messages); if (!document.hidden) { markRead(); } }
        if (state.items[id] && state.items[id].status !== data.status) { setThreadStatus(data.status, data.read_only); }
      }));
    }
    Promise.all(jobs).then(function () {
      state.failures = 0;
      root.classList.remove('offline');
      schedule();
    }, function () {
      state.failures = Math.min(state.failures + 1, 6);
      ui.listState.hidden = false;
      ui.listState.className = 'state state-error';
      ui.listState.textContent = 'Connection problem — retrying…';
      schedule();
    });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) { schedule(0); } });

  // ------------------------------------------------------------ events
  var debounce;
  ui.filters.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(function () { loadList(true); }, 300); });
  ui.filters.addEventListener('change', function () { loadList(true); });
  ui.filters.addEventListener('submit', function (e) { e.preventDefault(); loadList(true); });
  ui.more.addEventListener('click', function () { loadList(false); });
  ui.back.addEventListener('click', function () { root.classList.remove('show-thread'); });
  ui.profileToggle.addEventListener('click', function () {
    var on = root.classList.toggle('show-profile');
    ui.profileToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  });
  ui.setStatus.addEventListener('change', function () {
    var id = state.current, status = ui.setStatus.value;
    request('POST', '/conversations/' + id + '/status', { status: status }).then(function () {
      setThreadStatus(status, false); renderList();
    }, function (e) { window.alert('Could not change status: ' + e.message); });
  });
  ui.composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = textarea.value.trim();
    if (!text) { return; }
    textarea.value = '';
    sendReply(text);
  });
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ui.composer.requestSubmit ? ui.composer.requestSubmit() : ui.composer.dispatchEvent(new Event('submit')); }
  });

  loadList(true).then(function () {
    var m = /[?&]c=(\d+)/.exec(window.location.search);
    if (m) { openConversation(parseInt(m[1], 10)); }
    schedule();
  });
})();
