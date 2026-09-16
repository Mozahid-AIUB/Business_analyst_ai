/* ============================================================================
   admin.js - the staff console (admin.html)

   This is not part of the customer application. It ships as its own page so
   that the console's markup and code never reach a customer's browser at all,
   rather than being hidden from them by a flag in app.js.

   It reads accounts and usage events through BRI.Auth and renders them; it
   runs no models, which is why ml.js is not loaded here.
   ========================================================================== */
(function () {
  'use strict';

  var Brand = window.BRI.Brand;
  var UI = window.BRI.UI, Auth = window.BRI.Auth, D = window.BRI.Data;
  var $ = UI.$, el = UI.el, clear = UI.clear, fmtInt = UI.fmtInt, fmtMoney = UI.fmtMoney,
      fmtPct = UI.fmtPct, fmt = UI.fmt, fmtTs = UI.fmtTs, fmtAgo = UI.fmtAgo,
      svg = UI.svg, attachTip = UI.attachTip, renderAttributions = UI.renderAttributions,
      openExport = UI.openExport, initialsOf = UI.initialsOf, nowStamp = UI.nowStamp;

  var session = { user: null };

  function track(type, meta) {
    try { Auth.track(type, meta); } catch (e) { /* tracking must never break the console */ }
  }

  /* ============================ admin console ============================ */

  var ACTIVITY_SERIES = [
    { key: 'scan', label: 'Scans', colour: 'var(--s1)' },
    { key: 'health', label: 'Health scores', colour: 'var(--s2)' },
    { key: 'login', label: 'Sign-ins', colour: 'var(--s3)' }
  ];

  function renderActivityChart(container, events, days) {
    clear(container);
    var dayMs = 86400000;
    var midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    var first = midnight.getTime() - (days - 1) * dayMs;

    var buckets = [];
    for (var d = 0; d < days; d++) buckets.push({ t: first + d * dayMs, scan: 0, health: 0, login: 0 });

    events.forEach(function (e) {
      var i = Math.floor((e.ts - first) / dayMs);
      if (i < 0 || i >= days) return;
      if (e.type === 'scan') buckets[i].scan++;
      else if (e.type === 'health' || e.type === 'portfolio') buckets[i].health++;
      else if (e.type === 'login') buckets[i].login++;
    });

    var maxStack = 1;
    buckets.forEach(function (b) { maxStack = Math.max(maxStack, b.scan + b.health + b.login); });

    var W = 660, H = 170, padL = 34, padR = 8, padT = 10, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    s.setAttribute('aria-label', 'Platform activity per day over the last ' + days + ' days');

    [0, 0.5, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      s.appendChild(svg('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
      var t = svg('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
      t.textContent = fmtInt(maxStack * f);
      s.appendChild(t);
    });

    var slot = plotW / days, bw = Math.min(26, slot - 4);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    buckets.forEach(function (b, i) {
      var x = padL + i * slot + (slot - bw) / 2;
      var yCursor = padT + plotH;
      var total = b.scan + b.health + b.login;

      ACTIVITY_SERIES.forEach(function (ser) {
        var v = b[ser.key];
        if (!v) return;
        var h = (v / maxStack) * plotH;
        yCursor -= h;
        var rect = svg('rect', {
          x: x, y: yCursor, width: bw, height: Math.max(h, 1.5), rx: 2,
          fill: ser.colour, stroke: 'var(--surface)', 'stroke-width': 1
        });
        s.appendChild(rect);
      });

      /* One hit area per day, taller than the bars, so the tooltip is easy to
         reach even on a quiet day. */
      var hit = svg('rect', {
        x: padL + i * slot, y: padT, width: slot, height: plotH, fill: 'transparent'
      });
      var dd = new Date(b.t);
      attachTip(hit, function () {
        return '<div class="t-title">' + dd.getDate() + ' ' + months[dd.getMonth()] + '</div>' +
          ACTIVITY_SERIES.map(function (ser) {
            return '<div class="t-row"><span>' + ser.label + '</span><b>' + fmtInt(b[ser.key]) + '</b></div>';
          }).join('') +
          '<div class="t-row"><span>Total</span><b>' + fmtInt(total) + '</b></div>';
      });
      s.appendChild(hit);

      if (i % Math.ceil(days / 7) === 0 || i === days - 1) {
        var lab = svg('text', { x: padL + i * slot + slot / 2, y: H - 8, 'text-anchor': 'middle' });
        lab.textContent = dd.getDate() + ' ' + months[dd.getMonth()];
        s.appendChild(lab);
      }
    });

    s.appendChild(svg('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, class: 'axis-line' }));
    container.appendChild(s);

    var legend = el('div', 'spark-legend');
    ACTIVITY_SERIES.forEach(function (ser) {
      var sp = el('span');
      var i2 = el('i');
      i2.style.background = ser.colour;
      sp.appendChild(i2);
      sp.appendChild(document.createTextNode(ser.label));
      legend.appendChild(sp);
    });
    container.appendChild(legend);
  }

  function renderAdmin() {
    var host = $('admin-body');
    if (!host) return;
    clear(host);
    if (!session.user || session.user.role !== 'admin') {
      host.appendChild(el('div', 'card')).appendChild(
        el('div', 'empty', 'This section is available to administrators only.'));
      return;
    }

    /* Both providers go through a promise: localStorage answers at once, the
       API cannot. */
    Promise.all([
      Promise.resolve().then(function () { return Auth.listUsers(); }).catch(function () { return []; }),
      Promise.resolve().then(function () { return Auth.events(); }).catch(function () { return []; })
    ]).then(function (res) { paintConsole(host, res[0] || [], res[1] || []); });
  }

  function paintConsole(host, users, events) {
    var byId = {};
    users.forEach(function (u) { byId[u.id] = u; });

    var dayMs = 86400000, now = Date.now();
    var scans = events.filter(function (e) { return e.type === 'scan'; });
    var healths = events.filter(function (e) { return e.type === 'health'; });
    var exports_ = events.filter(function (e) { return e.type === 'export'; });
    var active7 = users.filter(function (u) { return u.lastLoginAt && now - u.lastLoginAt < 7 * dayMs; });
    var rowsProcessed = scans.reduce(function (a, e) { return a + (e.meta.rows || 0); }, 0);
    var exposure = scans.reduce(function (a, e) { return a + (e.meta.exposure || 0); }, 0);
    var flagged = scans.reduce(function (a, e) { return a + (e.meta.high || 0) + (e.meta.medium || 0); }, 0);

    if (Auth.isDemo) {
      var diag = Auth.diagnostics();
      var banner = el('div', 'banner banner-warn');
      banner.innerHTML = '<span><b>Demo mode.</b> Accounts and activity live in this browser only — ' +
        'nothing is shared between devices and anyone with the browser can edit it. ' +
        diag.seededUsers + ' of ' + diag.users + ' accounts and ' + fmtInt(diag.seededEvents) +
        ' of ' + fmtInt(diag.events) + ' events are seeded sample data, marked <b>sample</b> in the tables below. ' +
        'Connecting a server replaces this without changing the screens.' +
        (diag.storageWorks ? '' : ' <b>Storage is blocked in this browser, so nothing will survive a reload.</b>') +
        '</span>';
      host.appendChild(banner);
    }

    var tiles = el('div', 'stat-row');
    [
      ['Accounts', fmtInt(users.length), users.filter(function (u) { return !u.active; }).length + ' disabled'],
      ['Active this week', fmtInt(active7.length), fmtPct(active7.length / Math.max(1, users.length)) + ' of accounts'],
      ['Scans run', fmtInt(scans.length), fmtInt(healths.length) + ' health scores'],
      ['Rows processed', fmtInt(rowsProcessed), fmtInt(flagged) + ' flagged'],
      ['Exposure reviewed', fmtMoney(exposure), 'Across all scans'],
      ['Exports taken', fmtInt(exports_.length), 'Queue and scored output']
    ].forEach(function (t) {
      var n = el('div', 'stat');
      n.appendChild(el('div', 'stat-label', t[0]));
      n.appendChild(el('div', 'stat-value sm', t[1]));
      n.appendChild(el('div', 'stat-meta', t[2]));
      tiles.appendChild(n);
    });
    host.appendChild(tiles);

    /* activity */
    var actCard = el('div', 'card');
    var ah = el('div', 'card-head');
    ah.appendChild(el('h3', null, 'Activity — last 30 days'));
    ah.appendChild(el('span', 'card-note', fmtInt(events.length) + ' events recorded'));
    actCard.appendChild(ah);
    var actChart = el('div', 'chart');
    actCard.appendChild(actChart);
    renderActivityChart(actChart, events, 30);
    host.appendChild(actCard);

    /* accounts table */
    var uCard = el('div', 'card flush');
    var uh = el('div', 'card-head');
    uh.style.padding = '14px 16px 0';
    uh.appendChild(el('h3', null, 'Accounts'));
    var uExp = el('button', 'btn btn-sm', 'Export');
    uExp.type = 'button';
    uExp.addEventListener('click', function () {
      openExport('accounts_' + Date.now() + '.csv', D.objectsToCSV(users.map(function (u) {
        var us = userStats(u, events);
        return {
          name: u.name, email: u.email, company: u.company, role: u.role,
          status: u.active ? 'active' : 'disabled',
          signed_up: new Date(u.createdAt).toISOString(),
          last_login: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : '',
          logins: u.loginCount, scans: us.scans, health_scores: us.healths,
          rows_processed: us.rows, sample_data: u.seeded ? 'yes' : 'no'
        };
      })), users.length);
    });
    uh.appendChild(uExp);
    uCard.appendChild(uh);

    var uWrap = el('div', 'table-wrap scroll-y');
    uWrap.style.marginTop = '12px';
    var ut = el('table', 'data');
    var uthead = el('thead');
    var utr = el('tr');
    ['', 'Account', 'Company', 'Role', 'Signed up', 'Last seen', 'Logins', 'Scans', 'Rows', 'Health', 'Status', ''].forEach(function (h) {
      utr.appendChild(el('th', null, h));
    });
    uthead.appendChild(utr);
    ut.appendChild(uthead);
    var utb = el('tbody');

    users.slice().sort(function (a, b) { return (b.lastLoginAt || 0) - (a.lastLoginAt || 0); }).forEach(function (u) {
      var us = userStats(u, events);
      var row = el('tr');

      var sc = el('td');
      sc.style.width = '6px';
      sc.style.padding = '0 0 0 12px';
      sc.appendChild(el('div', 'stripe ' + (!u.active ? 'stripe-neutral' : (us.scans ? 'stripe-good' : 'stripe-warning'))));
      row.appendChild(sc);

      var who = el('td', 'wrap');
      who.appendChild(el('div', null, u.name));
      var sub = el('div', 'dim');
      sub.style.fontSize = '11px';
      sub.textContent = u.email;
      who.appendChild(sub);
      row.appendChild(who);

      row.appendChild(el('td', 'dim', u.company || '—'));

      var rd = el('td');
      rd.appendChild(el('span', 'chip ' + (u.role === 'admin' ? 'chip-good' : 'chip-neutral'),
        u.role === 'admin' ? 'staff' : 'customer'));
      if (u.seeded) rd.appendChild(el('span', 'chip chip-neutral', 'sample'));
      row.appendChild(rd);

      row.appendChild(el('td', 'dim', fmtTs(u.createdAt)));
      var seen = el('td', 'dim', fmtAgo(u.lastLoginAt));
      seen.title = u.lastLoginAt ? fmtTs(u.lastLoginAt) : 'Has never signed in';
      row.appendChild(seen);
      row.appendChild(el('td', 'n', fmtInt(u.loginCount)));
      row.appendChild(el('td', 'n', fmtInt(us.scans)));
      row.appendChild(el('td', 'n', fmtInt(us.rows)));
      row.appendChild(el('td', 'n', fmtInt(us.healths)));

      var st = el('td');
      st.appendChild(el('span', 'chip ' + (u.active ? 'chip-good' : 'chip-critical'), u.active ? 'active' : 'disabled'));
      row.appendChild(st);

      var act = el('td');
      if (u.role !== 'admin') {
        var tg = el('button', 'btn btn-sm', u.active ? 'Disable' : 'Enable');
        tg.type = 'button';
        tg.addEventListener('click', function () {
          try {
            Promise.resolve()
              .then(function () { return Auth.setActive(u.id, !u.active); })
              .then(function () {
                track('admin_toggle_user', { userId: u.id, active: !u.active });
                renderAdmin();
              })
              .catch(function (ex) { alert(ex.message); });
          } catch (ex) { alert(ex.message); }
        });
        act.appendChild(tg);
      }
      row.appendChild(act);
      utb.appendChild(row);
    });
    ut.appendChild(utb);
    uWrap.appendChild(ut);
    uCard.appendChild(uWrap);
    host.appendChild(uCard);

    /* scan + health history side by side */
    var grid = el('div', 'console-grid');
    grid.appendChild(historyCard('Scan history', scans, 120, function (e) {
      var u = byId[e.userId];
      return [
        ['when', fmtTs(e.ts), 'dim'],
        ['who', u ? u.name : 'unknown', null],
        ['file', e.meta.file || 'upload', 'dim'],
        ['rows', fmtInt(e.meta.rows), 'n'],
        ['high', fmtInt(e.meta.high), 'n'],
        ['exposure', fmtMoney(e.meta.exposure), 'n']
      ];
    }, ['When', 'User', 'File', 'Rows', 'High', 'Exposure'], function (e) {
      return e.meta.high > 0 ? 'stripe-critical' : 'stripe-good';
    }));

    grid.appendChild(historyCard('Health score history', healths, 120, function (e) {
      var u = byId[e.userId];
      return [
        ['when', fmtTs(e.ts), 'dim'],
        ['who', u ? u.name : 'unknown', null],
        ['company', e.meta.company || '—', 'dim'],
        ['score', e.meta.score != null ? e.meta.score.toFixed(1) : '—', 'n'],
        ['grade', e.meta.grade || '—', 'dim'],
        ['pfail', e.meta.failureProb != null ? fmtPct(e.meta.failureProb, 1) : '—', 'n']
      ];
    }, ['When', 'User', 'Company', 'Score', 'Grade', 'p(fail)'], function (e) {
      var sc2 = e.meta.score;
      if (sc2 == null) return 'stripe-neutral';
      return sc2 >= 75 ? 'stripe-good' : (sc2 >= 40 ? 'stripe-warning' : 'stripe-critical');
    }));
    host.appendChild(grid);

    /* feature usage */
    var fCard = el('div', 'card');
    var fh = el('div', 'card-head');
    fh.appendChild(el('h3', null, 'What gets used'));
    fh.appendChild(el('span', 'card-note', 'Every recorded event, by type'));
    fCard.appendChild(fh);

    var counts = {};
    events.forEach(function (e) { counts[e.type] = (counts[e.type] || 0) + 1; });
    var LABELS = {
      login: 'Sign-in', signup: 'Account created', logout: 'Sign-out',
      scan: 'Transaction scan', health: 'Health score', portfolio: 'Portfolio scoring',
      export: 'Export taken', retrain: 'Model refit', admin_toggle_user: 'Account enabled or disabled'
    };
    var fChart = el('div');
    renderAttributions(fChart, Object.keys(counts).map(function (k) {
      return { label: LABELS[k] || k, value: counts[k], hint: 'Events of type "' + k + '"' };
    }).sort(function (a, b) { return b.value - a.value; }),
      { unit: 'Events', format: function (v) { return fmtInt(v); } });
    fCard.appendChild(fChart);
    fCard.appendChild(el('div', 'hint',
      'Counts are events, not sessions — a single visit usually produces one sign-in and several scans.'));
    host.appendChild(fCard);

    /* raw export */
    var expCard = el('div', 'card');
    var eh = el('div', 'card-head');
    eh.appendChild(el('h3', null, 'Raw usage export'));
    expCard.appendChild(eh);
    expCard.appendChild(el('div', 'hint',
      'The full event log with every recorded field, for reporting or for loading into another system.'));
    var erow = el('div', 'btn-row');
    erow.style.marginTop = '10px';
    var csvBtn = el('button', 'btn', 'Export events as CSV');
    csvBtn.type = 'button';
    csvBtn.addEventListener('click', function () {
      openExport('usage_events_' + Date.now() + '.csv', D.objectsToCSV(events.map(function (e) {
        var u = byId[e.userId];
        return {
          timestamp: new Date(e.ts).toISOString(), type: e.type,
          user_email: u ? u.email : '', user_name: u ? u.name : '', company: u ? u.company : '',
          rows: e.meta.rows != null ? e.meta.rows : '',
          high: e.meta.high != null ? e.meta.high : '',
          medium: e.meta.medium != null ? e.meta.medium : '',
          exposure: e.meta.exposure != null ? e.meta.exposure : '',
          score: e.meta.score != null ? e.meta.score : '',
          failure_probability: e.meta.failureProb != null ? e.meta.failureProb : '',
          file: e.meta.file || '', sample_data: e.seeded ? 'yes' : 'no'
        };
      })), events.length);
    });
    erow.appendChild(csvBtn);
    var jsonBtn = el('button', 'btn', 'Export everything as JSON');
    jsonBtn.type = 'button';
    jsonBtn.addEventListener('click', function () {
      openExport('console_export_' + Date.now() + '.json',
        JSON.stringify({ exportedAt: nowStamp(), provider: Auth.provider, users: users, events: events }, null, 2),
        users.length + events.length);
    });
    erow.appendChild(jsonBtn);
    expCard.appendChild(erow);
    host.appendChild(expCard);
  }

  function userStats(user, events) {
    var scans = 0, healths = 0, rows = 0;
    events.forEach(function (e) {
      if (e.userId !== user.id) return;
      if (e.type === 'scan') { scans++; rows += e.meta.rows || 0; }
      else if (e.type === 'health') healths++;
    });
    return { scans: scans, healths: healths, rows: rows };
  }

  function historyCard(title, events, limit, cellsFn, headers, stripeFn) {
    var card = el('div', 'card flush');
    var h = el('div', 'card-head');
    h.style.padding = '14px 16px 0';
    h.appendChild(el('h3', null, title));
    h.appendChild(el('span', 'card-note', fmtInt(events.length) + ' records'));
    card.appendChild(h);

    if (!events.length) {
      card.appendChild(el('div', 'empty', 'Nothing recorded yet.'));
      return card;
    }

    var wrap = el('div', 'table-wrap scroll-y');
    wrap.style.marginTop = '12px';
    var t = el('table', 'data');
    var thead = el('thead');
    var tr = el('tr');
    tr.appendChild(el('th', null, ''));
    headers.forEach(function (hd) { tr.appendChild(el('th', null, hd)); });
    thead.appendChild(tr);
    t.appendChild(thead);

    var tb = el('tbody');
    events.slice(0, limit).forEach(function (e) {
      var row = el('tr');
      var sc = el('td');
      sc.style.width = '6px';
      sc.style.padding = '0 0 0 12px';
      sc.appendChild(el('div', 'stripe ' + stripeFn(e)));
      row.appendChild(sc);
      cellsFn(e).forEach(function (c) { row.appendChild(el('td', c[2], c[1])); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    card.appendChild(wrap);
    if (events.length > limit) {
      var note = el('div', 'hint');
      note.style.padding = '10px 16px';
      note.textContent = 'Showing the most recent ' + fmtInt(limit) + ' of ' + fmtInt(events.length) + '. Export for the full set.';
      card.appendChild(note);
    }
    return card;
  }

  /* =============================== the gate ============================== */
  /* One message for every rejection - wrong password, unknown email, or a
     customer account reaching a staff URL. A console that says "that account
     exists but is not staff" tells an attacker which address to work on. */

  var NOT_STAFF = 'This console is for staff accounts only.';

  function showGate(message) {
    var gate = $('admin-gate');
    clear(gate);
    gate.hidden = false;
    $('admin-shell').hidden = true;

    var card = el('div', 'auth-card');

    var brand = el('div', 'auth-brand');
    var mark = el('div', 'brand-mark');
    mark.innerHTML = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<path d="M10 1.8 3.2 4.6v5.1c0 4 2.9 7.4 6.8 8.5 3.9-1.1 6.8-4.5 6.8-8.5V4.6L10 1.8Z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M6.9 10.1l2.1 2.2 4.1-4.6" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    brand.appendChild(mark);
    var bt = el('div');
    bt.appendChild(el('div', 'brand-name', Brand.name));
    bt.appendChild(el('div', 'brand-sub', 'Staff console'));
    brand.appendChild(bt);
    card.appendChild(brand);

    var panel = el('div', 'auth-panel');

    var head = el('div');
    head.appendChild(el('h1', null, 'Staff sign-in'));
    head.appendChild(el('p', 'lede',
      'Accounts, usage and the raw event log for the whole platform.'));
    panel.appendChild(head);

    var form = el('form', 'auth-form');
    var err = el('div', 'auth-error');
    err.hidden = true;
    if (message) { err.textContent = message; err.hidden = false; }
    panel.appendChild(err);

    function field(id, label, type, placeholder, autocomplete) {
      var f = el('div', 'field');
      var l = el('label');
      l.setAttribute('for', id);
      l.appendChild(document.createTextNode(label));
      f.appendChild(l);
      var i = el('input');
      i.type = type;
      i.id = id;
      i.placeholder = placeholder || '';
      if (autocomplete) i.autocomplete = autocomplete;
      f.appendChild(i);
      form.appendChild(f);
      return i;
    }

    var emailIn = field('admin-email', 'Email', 'text', 'you@rebintech.com', 'email');
    var passIn = field('admin-password', 'Password', 'password', '', 'current-password');

    var submit = el('button', 'btn btn-primary btn-block', 'Sign in');
    submit.type = 'submit';
    form.appendChild(submit);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;
      var user;
      try {
        user = Auth.signIn(emailIn.value, passIn.value);
      } catch (ex) {
        fail(ex.message);
        return;
      }
      /* The credentials were right, but the console is not theirs. Tear the
         session down before anything renders, so a customer who lands here
         is not left holding a signed-in session against a staff URL. */
      if (user.role !== 'admin') {
        /* End the session before saying no, so a refusal cannot be retried
           by simply reloading the page. */
        Promise.resolve()
          .then(function () { return Auth.signOut(); })
          .catch(function () {})
          .then(function () { fail(NOT_STAFF); });
        return;
      }
      enterConsole(user);

      function fail(msg) {
        err.textContent = msg;
        err.hidden = false;
        passIn.value = '';
        passIn.focus();
      }
    });

    panel.appendChild(form);

    /* No sign-up tab, deliberately: an admin role is something granted, and a
       console that lets anyone mint one is not a console. */
    var note = el('div', 'hint',
      'There is no sign-up here — staff accounts are created by an administrator. ' +
      'Customers sign in to the application instead.');
    panel.appendChild(note);

    var back = el('div', 'hint');
    var link = el('a', null, 'Go to the customer application');
    link.href = 'index.html';
    back.appendChild(link);
    panel.appendChild(back);

    card.appendChild(panel);
    gate.appendChild(card);
    emailIn.focus();
  }

  function enterConsole(user) {
    session.user = user;
    $('admin-gate').hidden = true;
    $('admin-shell').hidden = false;

    var who = $('admin-who');
    if (who) who.textContent = initialsOf(user) + ' · ' + user.email;

    renderAdmin();
  }

  function signOut() {
    Promise.resolve()
      .then(function () { return Auth.signOut(); })
      .catch(function () {})
      .then(function () {
        session.user = null;
        showGate(null);
      });
  }

  /* ================================= boot ================================ */

  function boot() {
    UI.initTheme();

    var out = $('admin-signout');
    if (out) out.addEventListener('click', signOut);

    /* An existing session is not enough - it could be a customer who signed in
       on the application and then typed this URL. The role is checked again on
       every load, and a customer session is ended rather than merely refused,
       so the next reload does not silently retry. */
    var existing = null;
    try { existing = Auth.currentUser(); } catch (e) { existing = null; }

    if (existing && existing.role === 'admin') enterConsole(existing);
    else if (existing) {
      Promise.resolve()
        .then(function () { return Auth.signOut(); })
        .catch(function () {})
        .then(function () { showGate(NOT_STAFF); });
    }
    else showGate(null);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
