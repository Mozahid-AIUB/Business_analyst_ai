/* ============================================================================
   ui.js - BRI.UI
   The presentation layer shared by the pages this product ships:
   app.html (the customer application), admin.html (the staff console) and
   index.html (the public landing page).

   Nothing here knows about fraud, financials or accounts. It is DOM plumbing,
   number formatting, the tooltip layer, the attribution bar chart, the modal
   and export dialogs, and the theme control - the parts both pages would
   otherwise each keep a diverging copy of.
   ========================================================================== */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  /* ============================== formatting ============================= */

  function fmtMoney(v, dp) {
    if (v == null || isNaN(v)) return '—';
    var abs = Math.abs(v), sign = v < 0 ? '-' : '';
    if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'K';
    return sign + '$' + abs.toFixed(dp == null ? 2 : dp);
  }

  function fmtInt(v) {
    if (v == null || isNaN(v)) return '—';
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtPct(v, dp) {
    if (v == null || isNaN(v)) return '—';
    return (v * 100).toFixed(dp == null ? 1 : dp) + '%';
  }

  function fmt(v, dp) {
    if (v == null || isNaN(v)) return '—';
    return v.toFixed(dp == null ? 3 : dp);
  }

  function nowStamp() {
    var d = new Date();
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }

  /* ------------------------------------------------------------ chart bits */

  var NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  var tooltipNode = null;

  function showTip(evt, html) {
    if (!tooltipNode) {
      tooltipNode = el('div', 'tooltip');
      document.body.appendChild(tooltipNode);
    }
    tooltipNode.innerHTML = html;
    tooltipNode.hidden = false;
    var r = tooltipNode.getBoundingClientRect();
    var x = evt.clientX + 14, y = evt.clientY - r.height - 10;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y < 8) y = evt.clientY + 18;
    tooltipNode.style.left = x + 'px';
    tooltipNode.style.top = y + 'px';
  }

  function hideTip() { if (tooltipNode) tooltipNode.hidden = true; }

  function attachTip(node, htmlFn) {
    node.addEventListener('mouseenter', function (e) { showTip(e, htmlFn()); });
    node.addEventListener('mousemove', function (e) { showTip(e, htmlFn()); });
    node.addEventListener('mouseleave', hideTip);
  }

  /* --------------------------- attribution bars -------------------------- */

  function renderAttributions(container, items, opts) {
    opts = opts || {};
    clear(container);
    if (!items.length) { container.appendChild(el('div', 'empty', 'No attributions available.')); return; }
    var maxAbs = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); })) || 1;
    var wrap = el('div', 'attr');

    items.forEach(function (it) {
      var row = el('div', 'attr-row');
      var name = el('div', 'attr-name', it.label);
      name.title = it.hint || it.label;
      var track = el('div', 'attr-track');
      var zero = el('div', 'attr-zero');
      zero.style.left = '50%';
      track.appendChild(zero);
      var bar = el('div', 'attr-bar ' + (it.value >= 0 ? 'up' : 'down'));
      var w = (Math.abs(it.value) / maxAbs) * 48;
      if (it.value >= 0) { bar.style.left = '50%'; bar.style.width = w + '%'; }
      else { bar.style.right = '50%'; bar.style.width = w + '%'; }
      track.appendChild(bar);
      attachTip(track, function () {
        return '<div class="t-title">' + it.label + '</div>' +
               (it.hint ? '<div class="t-row"><span>' + it.hint + '</span></div>' : '') +
               (it.detail ? '<div class="t-row"><span>Observed</span><b>' + it.detail + '</b></div>' : '') +
               '<div class="t-row"><span>' + (opts.unit || 'Effect') + '</span><b>' +
               (it.value >= 0 ? '+' : '') + (opts.format ? opts.format(it.value) : fmt(it.value, 4)) + '</b></div>';
      });
      var val = el('div', 'attr-val', (it.value >= 0 ? '+' : '') + (opts.format ? opts.format(it.value) : fmt(it.value, 3)));
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(val);
      wrap.appendChild(row);
    });
    container.appendChild(wrap);
  }

  /* --------------------------------- gauge ------------------------------- */


  /* ----------------------------------------------------------- time format */

  function fmtTs(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' +
           String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtAgo(ts) {
    if (!ts) return 'never';
    var s = (Date.now() - ts) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  function initialsOf(user) {
    var parts = String(user.name || user.email).trim().split(/\s+/);
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(user.name || user.email).slice(0, 2).toUpperCase();
  }

  /* --------------------------------------------------------------- modals */

  function openModal(title, bodyNode) {
    var back = el('div', 'modal-back');
    var modal = el('div', 'modal');
    var head = el('div', 'modal-head');
    head.appendChild(el('h3', null, title));
    var close = el('button', 'icon-btn');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.style.fontSize = '18px';
    close.addEventListener('click', function () { document.body.removeChild(back); });
    head.appendChild(close);
    modal.appendChild(head);
    var body = el('div', 'modal-body');
    body.appendChild(bodyNode);
    modal.appendChild(body);
    back.appendChild(modal);
    back.addEventListener('click', function (e) { if (e.target === back) document.body.removeChild(back); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && back.parentNode) { document.body.removeChild(back); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(back);
    close.focus();
    return back;
  }

  function openExport(filename, content, rowCount) {
    track('export', { kind: filename.replace(/_\d+\.(csv|json)$/, ''), rows: rowCount });
    var body = el('div');
    var info = el('div', 'hint');
    info.textContent = fmtInt(rowCount) + ' records · ' + filename;
    body.appendChild(info);

    var ta = el('textarea');
    ta.value = content;
    ta.readOnly = true;
    ta.setAttribute('aria-label', 'Export contents');
    body.appendChild(ta);

    var row = el('div', 'btn-row');
    var copy = el('button', 'btn btn-primary', 'Copy to clipboard');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      ta.select();
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy to clipboard'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(content).then(done, function () { document.execCommand('copy'); done(); });
      } else { document.execCommand('copy'); done(); }
    });
    row.appendChild(copy);

    var dl = el('a', 'btn');
    dl.textContent = 'Download file';
    dl.download = filename;
    dl.href = URL.createObjectURL(new Blob([content], { type: filename.slice(-4) === 'json' ? 'application/json' : 'text/csv' }));
    row.appendChild(dl);
    body.appendChild(row);

    body.appendChild(el('div', 'hint', 'Download works when the platform is opened from a file or a web host. Copy to clipboard works everywhere, including inside an embedded preview.'));
    openModal('Export', body);
  }

  /* --------------------------------------------------------------- theme */
  /* Cream is the product's face, so the page opens on it whatever the
     operating system prefers. Dark is reached only by choosing it, and that
     choice stamps data-theme on the root element.

     Several toggles can be on screen at once - the sidebar has one, the
     sign-in screen has one, the staff console has its own - so they are found
     by attribute and kept in step, rather than each owning an id. The stored
     preference is a per-viewer convenience: every access is wrapped, because
     it throws in a private window and comes back empty after cleared data. */

  var THEME_KEY = 'business-analytics-theme';

  var THEME_ICONS =
    '<svg class="theme-icon-dark" width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
    '<svg class="theme-icon-light" width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true" hidden>' +
    '<circle cx="10" cy="10" r="3.6" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10 1.6v2M10 16.4v2M18.4 10h-2M3.6 10h-2M15.9 4.1l-1.4 1.4M5.5 14.5l-1.4 1.4M15.9 15.9l-1.4-1.4M5.5 5.5 4.1 4.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function currentlyDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function syncThemeButtons() {
    var dark = currentlyDark();
    var list = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      var moon = btn.querySelector('.theme-icon-dark');
      var sun = btn.querySelector('.theme-icon-light');
      if (moon) moon.hidden = dark;
      if (sun) sun.hidden = !dark;
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  function setTheme(next) {
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    syncThemeButtons();
  }

  function wireThemeToggle(btn) {
    btn.addEventListener('click', function () { setTheme(currentlyDark() ? 'light' : 'dark'); });
  }

  /* For toggles that are built at run time rather than sitting in the HTML. */
  function makeThemeToggle() {
    var btn = el('button', 'icon-btn');
    btn.type = 'button';
    btn.setAttribute('data-theme-toggle', '');
    btn.innerHTML = THEME_ICONS;
    wireThemeToggle(btn);
    return btn;
  }

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ }
    if (stored === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    var list = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < list.length; i++) wireThemeToggle(list[i]);
    syncThemeButtons();
  }

  /* --------------------------------------------------------------- export */

  global.BRI = global.BRI || {};
  global.BRI.UI = {
    $: $, el: el, clear: clear,
    fmtMoney: fmtMoney, fmtInt: fmtInt, fmtPct: fmtPct, fmt: fmt, nowStamp: nowStamp,
    fmtTs: fmtTs, fmtAgo: fmtAgo, initialsOf: initialsOf,
    svg: svg, showTip: showTip, hideTip: hideTip, attachTip: attachTip,
    renderAttributions: renderAttributions,
    openModal: openModal, openExport: openExport,
    currentlyDark: currentlyDark, syncThemeButtons: syncThemeButtons,
    setTheme: setTheme, makeThemeToggle: makeThemeToggle, initTheme: initTheme
  };
})(typeof window !== 'undefined' ? window : globalThis);
