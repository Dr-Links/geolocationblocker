/* Signalpost live visitors. Polls a bounded snapshot; distinguishes "active now"
   from "recently seen" using the server-defined activity window. */
(function () {
  'use strict';
  var root = document.getElementById('live');
  if (!root) { return; }
  var WS = root.getAttribute('data-ws');
  var POLL = Math.max(5000, parseInt(root.getAttribute('data-poll-ms'), 10) || 10000);
  var tbody = root.querySelector('[data-rows]');
  var updated = root.querySelector('[data-updated]');
  var failures = 0;
  var timer = null;
  function fmt(s) { return window.SignalpostFormatTime ? window.SignalpostFormatTime(s) : String(s || ''); }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = String(text); } return n; }

  function ago(sec) {
    if (sec < 60) { return sec + ' s ago'; }
    if (sec < 3600) { return Math.floor(sec / 60) + ' min ago'; }
    return Math.floor(sec / 3600) + ' h ago';
  }

  function render(data) {
    tbody.textContent = '';
    if (!data.items.length) {
      var tr = el('tr'); var td = el('td', 'state', 'No active or recently seen visitors.'); td.colSpan = 7; tr.appendChild(td); tbody.appendChild(tr);
    }
    data.items.forEach(function (v) {
      var tr = el('tr');
      var st = el('td');
      st.appendChild(el('span', v.state === 'active' ? 'live-dot' : 'recent-dot'));
      st.appendChild(document.createTextNode(v.state === 'active' ? ' Active now' : ' Recently seen'));
      tr.appendChild(st);
      var who = el('td');
      var a = el('a', null, v.name || ('Visitor ' + v.public_id.slice(0, 8)));
      a.href = '/w/' + WS + '/visitors/' + v.id;
      who.appendChild(a);
      tr.appendChild(who);
      tr.appendChild(el('td', null, v.website));
      var page = el('td');
      if (v.last_page) {
        page.appendChild(el('code', null, v.last_page));
        page.appendChild(el('div', 'muted small', 'observed ' + fmt(v.last_page_at)));
      } else {
        page.appendChild(el('span', 'muted', 'not tracked'));
      }
      tr.appendChild(page);
      tr.appendChild(el('td', null, ago(v.seconds_since_seen)));
      tr.appendChild(el('td', null, v.country ? v.country + ' (est.)' : '—'));
      var act = el('td');
      if (v.open_conversation_id) {
        var c = el('a', 'btn btn-sm', 'Open chat');
        c.href = '/w/' + WS + '/inbox?c=' + v.open_conversation_id;
        act.appendChild(c);
      }
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    updated.textContent = 'Updated ' + fmt(data.generated_at);
  }

  function tick() {
    fetch('/api/v1/dashboard/w/' + WS + '/live', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (r.status === 401) { window.location.href = '/login'; } if (!r.ok) { throw new Error(r.status); } return r.json(); })
      .then(function (j) { failures = 0; render(j.data); schedule(); }, function () {
        failures = Math.min(failures + 1, 6);
        updated.textContent = 'Connection problem — retrying…';
        schedule();
      });
  }

  function schedule() {
    clearTimeout(timer);
    var wait = document.hidden ? POLL * 4 : POLL;
    if (failures) { wait = Math.min(60000, POLL * Math.pow(2, failures)); }
    timer = setTimeout(tick, wait);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { clearTimeout(timer); tick(); } });
  tick();
})();
