/* ============================================================================
   app.js - Sentinel Risk Desk
   Wires the models in ml.js and the data layer in data.js to the three
   working sections of the platform, and records every fit and scoring batch
   in the run log that Section 3 publishes.
   ========================================================================== */
(function () {
  'use strict';

  var ML = window.BRI.ML;
  var D = window.BRI.Data;

  /* ================================ state ================================ */

  var state = {
    tab: 'scanner',
    runLog: [],
    fraud: null,
    business: null,
    text: null,
    scan: { rows: [], headers: [], mapping: {}, source: '', scored: null, view: 'queue', page: 0 },
    health: { mode: 'manual', rows: [], headers: [], mapping: {}, result: null, portfolio: null },
    method: { model: 'ensemble', threshold: null }
  };

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

  /* ================================ run log ============================== */

  function logRun(entry) {
    entry.id = 'RUN-' + String(state.runLog.length + 1).padStart(4, '0');
    entry.ts = nowStamp();
    state.runLog.push(entry);
    return entry;
  }

  function timed(fn) {
    var t0 = performance.now();
    var out = fn();
    return { out: out, ms: performance.now() - t0 };
  }

  /* ============================ severity bands =========================== */

  function bandOf(p, thresholds) {
    if (p >= thresholds.high) return { key: 'high', label: 'High', chip: 'chip-critical', stripe: 'stripe-critical' };
    if (p >= thresholds.medium) return { key: 'medium', label: 'Medium', chip: 'chip-warning', stripe: 'stripe-warning' };
    return { key: 'low', label: 'Low', chip: 'chip-good', stripe: 'stripe-good' };
  }

  /* ============================= chart helpers =========================== */

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

  /* --------------------------- risk distribution ------------------------- */

  function renderHistogram(container, scores, thresholds) {
    clear(container);
    var bins = 20, counts = new Array(bins).fill(0);
    scores.forEach(function (s) {
      var i = Math.min(bins - 1, Math.floor(ML.clamp(s, 0, 0.9999) * bins));
      counts[i]++;
    });
    var maxC = Math.max.apply(null, counts) || 1;

    var W = 620, H = 150, padL = 38, padR = 8, padB = 26, padT = 10;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    s.setAttribute('aria-label', 'Distribution of risk scores across the scored dataset');

    /* y grid at 0, half, max */
    [0, 0.5, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      s.appendChild(svg('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
      var t = svg('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' });
      t.textContent = fmtInt(maxC * f);
      s.appendChild(t);
    });

    var bw = plotW / bins;
    for (var i = 0; i < bins; i++) {
      var lo = i / bins, hi = (i + 1) / bins;
      var mid = (lo + hi) / 2;
      var band = bandOf(mid, thresholds);
      var h = (counts[i] / maxC) * plotH;
      var colour = band.key === 'high' ? 'var(--critical)' : (band.key === 'medium' ? 'var(--warning)' : 'var(--s1)');
      var rect = svg('rect', {
        x: padL + i * bw + 1, y: padT + plotH - h,
        width: Math.max(1, bw - 2), height: Math.max(h, counts[i] > 0 ? 1.5 : 0),
        rx: 2, fill: colour, stroke: 'var(--surface)', 'stroke-width': 1
      });
      (function (lo, hi, c, bandLabel) {
        attachTip(rect, function () {
          return '<div class="t-title">Risk ' + lo.toFixed(2) + ' – ' + hi.toFixed(2) + '</div>' +
                 '<div class="t-row"><span>Transactions</span><b>' + fmtInt(c) + '</b></div>' +
                 '<div class="t-row"><span>Band</span><b>' + bandLabel + '</b></div>';
        });
      })(lo, hi, counts[i], band.label);
      s.appendChild(rect);
    }

    /* Threshold markers name the values the platform actually operates on. */
    [{ v: thresholds.medium, label: 'Medium' }, { v: thresholds.high, label: 'High' }].forEach(function (m) {
      var x = padL + m.v * plotW;
      s.appendChild(svg('line', { x1: x, y1: padT - 4, x2: x, y2: padT + plotH, stroke: 'var(--ink-2)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
      var t = svg('text', { x: x + 3, y: padT + 4 });
      t.setAttribute('fill', 'var(--ink-2)');
      t.textContent = m.label + ' ' + m.v.toFixed(2);
      s.appendChild(t);
    });

    s.appendChild(svg('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, class: 'axis-line' }));
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var t = svg('text', { x: padL + f * plotW, y: H - 8, 'text-anchor': 'middle' });
      t.textContent = f.toFixed(2);
      s.appendChild(t);
    });
    container.appendChild(s);
  }

  /* -------------------------------- ROC ---------------------------------- */

  function renderROC(container, series) {
    clear(container);
    var W = 340, H = 300, pad = 38;
    var plotW = W - pad - 12, plotH = H - pad - 26;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    s.setAttribute('aria-label', 'ROC curves for each model on the held-out test split');

    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = 12 + plotH - f * plotH;
      s.appendChild(svg('line', { x1: pad, y1: y, x2: pad + plotW, y2: y, class: 'grid-line' }));
      var t = svg('text', { x: pad - 6, y: y + 3, 'text-anchor': 'end' });
      t.textContent = f.toFixed(2);
      s.appendChild(t);
      var x = pad + f * plotW;
      var t2 = svg('text', { x: x, y: 12 + plotH + 15, 'text-anchor': 'middle' });
      t2.textContent = f.toFixed(2);
      s.appendChild(t2);
    });

    s.appendChild(svg('line', {
      x1: pad, y1: 12 + plotH, x2: pad + plotW, y2: 12,
      stroke: 'var(--axis)', 'stroke-width': 1, 'stroke-dasharray': '4 4'
    }));

    series.forEach(function (ser) {
      var dStr = ser.points.map(function (p, i) {
        return (i ? 'L' : 'M') + (pad + p.fpr * plotW).toFixed(1) + ' ' + (12 + plotH - p.tpr * plotH).toFixed(1);
      }).join(' ');
      s.appendChild(svg('path', {
        d: dStr, fill: 'none', stroke: ser.colour, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
    });

    s.appendChild(svg('line', { x1: pad, y1: 12 + plotH, x2: pad + plotW, y2: 12 + plotH, class: 'axis-line' }));
    s.appendChild(svg('line', { x1: pad, y1: 12, x2: pad, y2: 12 + plotH, class: 'axis-line' }));

    var xl = svg('text', { x: pad + plotW / 2, y: H - 4, 'text-anchor': 'middle' });
    xl.textContent = 'False positive rate';
    s.appendChild(xl);
    var yl = svg('text', { x: 10, y: 12 + plotH / 2, 'text-anchor': 'middle', transform: 'rotate(-90 10 ' + (12 + plotH / 2) + ')' });
    yl.textContent = 'True positive rate';
    s.appendChild(yl);

    container.appendChild(s);

    var legend = el('div', 'legend');
    series.forEach(function (ser) {
      var sp = el('span');
      var i = el('i');
      i.style.background = ser.colour;
      sp.appendChild(i);
      sp.appendChild(document.createTextNode(ser.name + '  AUC ' + fmt(ser.auc, 3)));
      legend.appendChild(sp);
    });
    container.appendChild(legend);
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

  var GRADE_COLOUR = {
    excellent: 'var(--good)', strong: 'var(--good)', good: 'var(--s1)',
    fair: 'var(--warning)', weak: 'var(--critical)'
  };

  function renderGauge(container, score, grade) {
    clear(container);
    var size = 158, r = 66, cx = size / 2, cy = size / 2;
    var circ = 2 * Math.PI * r;
    var s = svg('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size });
    s.appendChild(svg('circle', { cx: cx, cy: cy, r: r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 12 }));
    s.appendChild(svg('circle', {
      cx: cx, cy: cy, r: r, fill: 'none',
      stroke: GRADE_COLOUR[grade.key] || 'var(--s1)',
      'stroke-width': 12, 'stroke-linecap': 'round',
      'stroke-dasharray': circ,
      'stroke-dashoffset': circ * (1 - ML.clamp(score / 100, 0, 1))
    }));
    container.appendChild(s);
    var centre = el('div', 'gauge-centre');
    var sc = el('div', 'gauge-score', String(Math.round(score)));
    sc.style.color = GRADE_COLOUR[grade.key] || 'var(--ink)';
    centre.appendChild(sc);
    centre.appendChild(el('div', 'gauge-outof', 'OUT OF 100'));
    container.appendChild(centre);
  }

  /* =========================== model suite build ========================= */

  /* Train the three models on one dataset and evaluate all of them on a
     held-out split. Everything returned here - metrics, thresholds, curves -
     is computed, and the run log records that it happened. */
  function buildSuite(name, rows, X, y, featureDefs, hyper) {
    var n = X.length;
    var cut = Math.floor(n * 0.7);
    var idx = [], i;
    var rnd = ML.mulberry32(99);
    for (i = 0; i < n; i++) idx.push(i);
    for (i = n - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    var trIdx = idx.slice(0, cut), teIdx = idx.slice(cut);
    var Xtr = trIdx.map(function (k) { return X[k]; });
    var ytr = trIdx.map(function (k) { return y[k]; });
    var Xte = teIdx.map(function (k) { return X[k]; });
    var yte = teIdx.map(function (k) { return y[k]; });

    var rfRun = timed(function () { return new ML.RandomForest(hyper.rf).fit(Xtr, ytr); });
    var gbRun = timed(function () { return new ML.GradientBoosting(hyper.gbt).fit(Xtr, ytr); });
    var lrRun = timed(function () { return new ML.LogisticRegression(hyper.lr).fit(Xtr, ytr); });
    var rf = rfRun.out, gbt = gbRun.out, lr = lrRun.out;

    function ensemble(x) { return (rf.predictProba(x) + gbt.predictProba(x)) / 2; }

    var scores = {
      rf: Xte.map(function (x) { return rf.predictProba(x); }),
      gbt: Xte.map(function (x) { return gbt.predictProba(x); }),
      lr: Xte.map(function (x) { return lr.predictProba(x); }),
      ensemble: Xte.map(ensemble)
    };

    var thrEns = ML.bestF1Threshold(yte, scores.ensemble);
    var thrF2 = ML.bestFBetaThreshold(yte, scores.ensemble, 2);
    var evals = {};
    Object.keys(scores).forEach(function (k) {
      var thr = ML.bestF1Threshold(yte, scores[k]);
      evals[k] = ML.evaluate(yte, scores[k], thr);
    });

    var curves = {
      rf: ML.rocCurve(yte, scores.rf),
      gbt: ML.rocCurve(yte, scores.gbt),
      lr: ML.rocCurve(yte, scores.lr),
      ensemble: ML.rocCurve(yte, scores.ensemble)
    };

    var sigma = [];
    for (var f = 0; f < X[0].length; f++) {
      sigma.push(ML.stdev(Xtr.map(function (r) { return r[f]; })) || 1e-6);
    }
    var bgRnd = ML.mulberry32(41);
    var background = [];
    for (i = 0; i < 40; i++) background.push(Xtr[Math.floor(bgRnd() * Xtr.length)].slice());

    [['Random Forest', rf, rfRun.ms, hyper.rf, evals.rf],
     ['XGBoost (gradient-boosted trees)', gbt, gbRun.ms, hyper.gbt, evals.gbt],
     ['Logistic Regression', lr, lrRun.ms, hyper.lr, evals.lr]].forEach(function (m) {
      logRun({
        job: 'fit', dataset: name, model: m[0],
        rows: Xtr.length, testRows: Xte.length, features: X[0].length,
        params: m[3], ms: m[2],
        metrics: { auc: m[4].auc, precision: m[4].precision, recall: m[4].recall, f1: m[4].f1, accuracy: m[4].accuracy }
      });
    });

    return {
      name: name, rf: rf, gbt: gbt, lr: lr,
      ensemble: ensemble,
      featureDefs: featureDefs,
      evals: evals, curves: curves, scores: scores,
      yTest: yte, Xtest: Xte, Xtrain: Xtr, yTrain: ytr,
      sigma: sigma, background: background,
      hyper: hyper,
      /* High = the balanced F1 cut-off, the point at which a case is worth
         stopping for. Medium = the F2 cut-off, which weights recall twice as
         heavily and is therefore lower: the band for "look at this today, but
         let it settle". Both are read off the held-out split. */
      thresholds: { high: thrEns, medium: Math.min(thrEns * 0.95, thrF2) },
      baseRate: ML.mean(y),
      rows: rows,
      trainMs: rfRun.ms + gbRun.ms + lrRun.ms
    };
  }

  /* Conservative, fixed defaults - shallow trees, a low learning rate and a
     real L2 penalty, which is what a rare positive class asks for. They were
     NOT selected by scoring the evaluation split; doing that would leak the
     test set into every number the leaderboard reports. */
  function fraudHyper() {
    return {
      rf: {
        nTrees: +($('cfg-rf-trees') ? $('cfg-rf-trees').value : 60),
        maxDepth: +($('cfg-rf-depth') ? $('cfg-rf-depth').value : 9),
        minSamplesLeaf: 4, seed: 7
      },
      gbt: {
        nRounds: +($('cfg-gb-rounds') ? $('cfg-gb-rounds').value : 120),
        maxDepth: 3,
        eta: +($('cfg-gb-eta') ? $('cfg-gb-eta').value : 0.05),
        lambda: 3.0, gamma: 0, subsample: 0.8, minChildWeight: 2, seed: 11
      },
      lr: { epochs: 500, lr: 0.35, l2: 0.002 }
    };
  }

  function trainFraud() {
    var rows = D.generateTransactions(3800, 2024);
    var mapping = {};
    D.TXN_FIELDS.forEach(function (f) { mapping[f.key] = f.key; });
    var built = D.buildTxnFeatures(rows, mapping);
    var y = built.meta.map(function (m) { return m.label; });
    state.fraud = buildSuite('Transactions (synthetic reference)', rows, built.X, y, D.TXN_FEATURES, fraudHyper());
    state.method.threshold = state.fraud.thresholds.high;
  }

  function trainBusiness() {
    var rows = D.generateCompanies(2600, 777);
    var X = [], y = [];
    rows.forEach(function (r) {
      X.push(D.financialsToFeatures(D.companyRowToFinancials(r)).vector);
      y.push(r.failed_within_24m);
    });
    state.business = buildSuite('Company financials (synthetic reference)', rows, X, y, D.FIN_FEATURES, {
      rf: { nTrees: 50, maxDepth: 8, minSamplesLeaf: 5, seed: 13 },
      gbt: { nRounds: 120, maxDepth: 3, eta: 0.06, lambda: 3.0, gamma: 0, subsample: 0.85, minChildWeight: 2, seed: 19 },
      lr: { epochs: 500, lr: 0.35, l2: 0.002 }
    });
  }

  function trainText() {
    var corpus = D.buildTextCorpus(31);
    var run = timed(function () {
      return new ML.TextEncoder({ dim: 12, epochs: 60, lr: 0.08, seed: 17, holdout: 0.2 })
        .fit(corpus.docs, corpus.labels);
    });
    state.text = run.out;
    state.text.corpusSize = corpus.docs.length;
    logRun({
      job: 'fit', dataset: 'Business narrative corpus', model: 'Transformer encoder (1 block, 1 head)',
      rows: state.text.nTrain, testRows: state.text.nTest, features: state.text.vocabList.length,
      params: { dim: 12, heads: 1, blocks: 1, epochs: 60, lr: 0.08, parameters: state.text.nParams },
      ms: run.ms,
      metrics: {
        auc: state.text.testAuc, trainAuc: state.text.trainAuc,
        finalLoss: state.text.lossCurve[state.text.lossCurve.length - 1]
      }
    });
  }

  /* =========================== SECTION 1 — SCANNER ======================= */

  function scanMappingCoverage() {
    return D.mappingCoverage(state.scan.mapping, D.TXN_FIELDS);
  }

  function renderScanControls() {
    var host = $('scan-controls');
    clear(host);

    /* upload */
    var upCard = el('div', 'card');
    var uh = el('div', 'card-head');
    uh.appendChild(el('h3', null, 'Transaction file'));
    upCard.appendChild(uh);

    var dz = el('div', 'dropzone');
    dz.setAttribute('role', 'button');
    dz.setAttribute('tabindex', '0');
    dz.appendChild(el('div', 'dropzone-title', 'Drop a transaction CSV'));
    dz.appendChild(el('div', 'dropzone-sub', 'or click to choose a file'));
    var fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = '.csv,text/csv,text/plain';
    fileInput.id = 'scan-file';
    fileInput.className = 'sr-only';
    dz.addEventListener('click', function () { fileInput.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) readScanFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function () { if (fileInput.files[0]) readScanFile(fileInput.files[0]); });
    upCard.appendChild(dz);
    upCard.appendChild(fileInput);

    var br = el('div', 'btn-row');
    br.style.marginTop = '10px';
    var sample = el('button', 'btn btn-sm', 'Load sample file');
    sample.type = 'button';
    sample.addEventListener('click', loadSampleTransactions);
    br.appendChild(sample);
    upCard.appendChild(br);

    var src = el('div', 'hint');
    src.style.marginTop = '8px';
    src.textContent = state.scan.source ? ('Loaded: ' + state.scan.source + ' — ' + fmtInt(state.scan.rows.length) + ' rows, ' + state.scan.headers.length + ' columns') : '';
    upCard.appendChild(src);
    host.appendChild(upCard);

    /* mapping */
    var mapCard = el('div', 'card');
    var mh = el('div', 'card-head');
    mh.appendChild(el('h3', null, 'Column mapping'));
    var cov = scanMappingCoverage();
    mh.appendChild(el('span', 'card-note', cov.mapped + ' of ' + cov.total + ' detected'));
    mapCard.appendChild(mh);

    if (!state.scan.headers.length) {
      mapCard.appendChild(el('div', 'hint', 'Load a file to map its columns.'));
    } else {
      var list = el('div', 'map-list');
      D.TXN_FIELDS.forEach(function (f) {
        var row = el('div', 'map-row');
        var lab = el('div', 'map-label');
        lab.appendChild(document.createTextNode(f.label));
        if (f.required) lab.appendChild(el('span', 'map-req', 'REQ'));
        row.appendChild(lab);
        var sel = el('select');
        sel.id = 'map-txn-' + f.key;
        var none = el('option', null, '— not mapped —');
        none.value = '';
        sel.appendChild(none);
        state.scan.headers.forEach(function (h) {
          var o = el('option', null, h);
          o.value = h;
          if (state.scan.mapping[f.key] === h) o.selected = true;
          sel.appendChild(o);
        });
        if (!state.scan.mapping[f.key]) sel.classList.add('unmapped');
        sel.addEventListener('change', function () {
          if (sel.value) state.scan.mapping[f.key] = sel.value;
          else delete state.scan.mapping[f.key];
          sel.classList.toggle('unmapped', !sel.value);
          renderScanControls();
        });
        row.appendChild(sel);
        list.appendChild(row);
      });
      mapCard.appendChild(list);

      if (cov.missingRequired.length) {
        var warn = el('div', 'banner banner-bad');
        warn.style.marginTop = '10px';
        warn.innerHTML = '<span><b>Map ' + cov.missingRequired.join(', ') + '</b> before analysing. Every other field is optional and will be imputed.</span>';
        mapCard.appendChild(warn);
      }

      var runBtn = el('button', 'btn btn-primary btn-block', 'Analyse transactions');
      runBtn.type = 'button';
      runBtn.id = 'scan-run';
      runBtn.style.marginTop = '12px';
      runBtn.disabled = cov.missingRequired.length > 0;
      runBtn.addEventListener('click', runScan);
      mapCard.appendChild(runBtn);
    }
    host.appendChild(mapCard);

    /* thresholds */
    if (state.fraud) {
      var tCard = el('div', 'card');
      var th = el('div', 'card-head');
      th.appendChild(el('h3', null, 'Operating thresholds'));
      tCard.appendChild(th);
      var t = state.fraud.thresholds;
      var dl = el('dl');
      dl.style.margin = '0';
      [['High risk at or above', t.high.toFixed(3)],
       ['Medium risk at or above', t.medium.toFixed(3)],
       ['High band rule', 'max F1, held-out split'],
       ['Medium band rule', 'max F2, held-out split'],
       ['Scoring model', 'RF + XGBoost mean']].forEach(function (kv) {
        var row = el('div', 'kv');
        row.appendChild(el('dt', null, kv[0]));
        row.appendChild(el('dd', null, kv[1]));
        dl.appendChild(row);
      });
      tCard.appendChild(dl);
      tCard.appendChild(el('div', 'hint', 'Thresholds come from the evaluation split in Section 3, not from a fixed 0.5 cut-off.'));
      host.appendChild(tCard);
    }
  }

  function readScanFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = D.parseCSV(reader.result);
      if (!parsed.headers.length) { alert('That file has no readable header row.'); return; }
      state.scan.rows = parsed.rows;
      state.scan.headers = parsed.headers;
      state.scan.mapping = D.autoMap(parsed.headers, D.TXN_FIELDS);
      state.scan.source = file.name;
      state.scan.scored = null;
      state.scan.page = 0;
      state.scan.view = 'preview';
      renderScanControls();
      renderScanResults();
      var cov = scanMappingCoverage();
      if (!cov.missingRequired.length) runScan();
    };
    reader.readAsText(file);
  }

  function loadSampleTransactions() {
    var rows = D.generateTransactions(900, 5150).map(function (r) {
      /* Sample file uses deliberately awkward headers so the mapper has
         something real to solve. */
      return {
        'Txn Ref': r.txn_id, 'Posted On': r.timestamp, 'Cust No': r.account_id,
        'Txn Amount (USD)': r.amount, 'Entry Mode': r.channel, 'Payee Name': r.merchant,
        'MCC Group': r.merchant_category, 'Payee Age (d)': r.merchant_age_days,
        'Txn Country': r.country, 'Billing Country': r.home_country,
        'New Device?': r.device_new ? 'Y' : 'N', 'Trans Count 24H': r.txn_count_24h,
        'Avg Txn 30D': r.avg_amount_30d, 'Days Since Open': r.account_age_days,
        'Particulars': r.memo, 'Confirmed Fraud': r.is_fraud
      };
    });
    state.scan.rows = rows;
    state.scan.headers = Object.keys(rows[0]);
    state.scan.mapping = D.autoMap(state.scan.headers, D.TXN_FIELDS);
    state.scan.source = 'transactions_sample.csv';
    state.scan.scored = null;
    state.scan.page = 0;
    renderScanControls();
    runScan();
  }

  function runScan() {
    if (!state.fraud) return;
    var cov = scanMappingCoverage();
    if (cov.missingRequired.length) return;

    var built = D.buildTxnFeatures(state.scan.rows, state.scan.mapping);
    var suite = state.fraud;
    var run = timed(function () {
      return built.X.map(function (x) { return suite.ensemble(x); });
    });
    var scores = run.out;

    var scored = scores.map(function (p, i) {
      var band = bandOf(p, suite.thresholds);
      var contrib = suite.rf.pathContributions(built.X[i], built.X[i].length);
      var drivers = contrib.contributions.map(function (v, k) {
        return { key: D.TXN_FEATURES[k].key, label: D.TXN_FEATURES[k].label, value: v, hint: D.TXN_FEATURES[k].hint, raw: built.X[i][k] };
      }).sort(function (a, b) { return b.value - a.value; });
      return {
        i: i, p: p, band: band, meta: built.meta[i], x: built.X[i],
        drivers: drivers,
        exposure: built.meta[i].amount * p
      };
    });

    logRun({
      job: 'score', dataset: state.scan.source || 'in-session upload',
      model: 'RF + XGBoost ensemble',
      rows: scored.length, features: built.X[0] ? built.X[0].length : 0,
      params: { thresholdHigh: suite.thresholds.high, thresholdMedium: suite.thresholds.medium, imputedFields: built.imputed.length },
      ms: run.ms,
      metrics: {
        high: scored.filter(function (s) { return s.band.key === 'high'; }).length,
        medium: scored.filter(function (s) { return s.band.key === 'medium'; }).length,
        meanScore: ML.mean(scores)
      }
    });

    state.scan.scored = { rows: scored, imputed: built.imputed, scoreMs: run.ms };
    state.scan.view = 'queue';
    renderScanResults();
    if (state.tab === 'method') renderMethodology();
  }

  function renderScanResults() {
    var host = $('scan-results');
    clear(host);
    var sc = state.scan.scored;

    if (!sc) {
      if (!state.scan.rows.length) {
        host.appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Load a transaction file to begin. The sample file exercises the full path.'));
      } else {
        var c = el('div', 'card');
        c.appendChild(el('div', 'empty', 'Map the required columns, then run the analysis.'));
        host.appendChild(c);
      }
      return;
    }

    var rows = sc.rows;
    var high = rows.filter(function (r) { return r.band.key === 'high'; });
    var med = rows.filter(function (r) { return r.band.key === 'medium'; });
    var scores = rows.map(function (r) { return r.p; });
    var valueAtRisk = rows.reduce(function (a, r) { return a + r.exposure; }, 0);
    var flaggedValue = high.concat(med).reduce(function (a, r) { return a + r.meta.amount; }, 0);
    var totalValue = rows.reduce(function (a, r) { return a + r.meta.amount; }, 0);

    /* headline tiles */
    var tiles = el('div', 'stat-row');
    [
      ['Transactions', fmtInt(rows.length), fmtMoney(totalValue) + ' total value'],
      ['High risk', fmtInt(high.length), fmtPct(high.length / rows.length) + ' of file'],
      ['Medium risk', fmtInt(med.length), fmtPct(med.length / rows.length) + ' of file'],
      ['Average risk score', ML.mean(scores).toFixed(3), 'Base rate ' + fmtPct(state.fraud.baseRate)],
      ['Value at risk', fmtMoney(valueAtRisk), 'Expected loss, amount × risk'],
      ['Flagged exposure', fmtMoney(flaggedValue), 'Face value of flagged rows']
    ].forEach(function (t) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'stat-label', t[0]));
      s.appendChild(el('div', 'stat-value', t[1]));
      s.appendChild(el('div', 'stat-meta', t[2]));
      tiles.appendChild(s);
    });
    host.appendChild(tiles);

    /* imputation notice — honest about what the upload did not carry */
    if (sc.imputed.length) {
      var b = el('div', 'banner banner-warn');
      b.innerHTML = '<span><b>' + sc.imputed.length + ' field' + (sc.imputed.length > 1 ? 's' : '') + ' imputed.</b> ' +
        sc.imputed.map(function (k) {
          var f = D.TXN_FIELDS.filter(function (x) { return x.key === k; })[0];
          return f ? f.label : k;
        }).join(', ') + ' were not in the file. The scorer substituted per-account medians where possible and a neutral default otherwise, so those features carry less signal than they would on a complete feed.</span>';
      host.appendChild(b);
    }

    /* distribution */
    var distCard = el('div', 'card');
    var dh = el('div', 'card-head');
    dh.appendChild(el('h3', null, 'Risk distribution'));
    dh.appendChild(el('span', 'card-note', 'Scored in ' + sc.scoreMs.toFixed(0) + ' ms'));
    distCard.appendChild(dh);
    var distChart = el('div', 'chart');
    distCard.appendChild(distChart);
    renderHistogram(distChart, scores, state.fraud.thresholds);
    var lg = el('div', 'legend');
    [['High', 'var(--critical)'], ['Medium', 'var(--warning)'], ['Low', 'var(--s1)']].forEach(function (p) {
      var sp = el('span');
      var i = el('i');
      i.style.background = p[1];
      sp.appendChild(i);
      sp.appendChild(document.createTextNode(p[0]));
      lg.appendChild(sp);
    });
    distCard.appendChild(lg);
    host.appendChild(distCard);

    /* views */
    var viewCard = el('div', 'card flush');
    var vh = el('div', 'card-head');
    vh.style.padding = '14px 16px 0';
    var seg = el('div', 'seg');
    [['preview', 'Dataset preview'], ['scored', 'Scored output'], ['queue', 'Investigation queue']].forEach(function (v) {
      var b = el('button', null, v[1]);
      b.type = 'button';
      b.setAttribute('aria-selected', state.scan.view === v[0] ? 'true' : 'false');
      b.addEventListener('click', function () { state.scan.view = v[0]; renderScanResults(); });
      seg.appendChild(b);
    });
    vh.appendChild(seg);
    var exp = el('button', 'btn btn-sm', 'Export');
    exp.type = 'button';
    exp.addEventListener('click', exportScan);
    vh.appendChild(exp);
    viewCard.appendChild(vh);

    var body = el('div');
    body.style.padding = '12px 0 0';
    viewCard.appendChild(body);

    if (state.scan.view === 'preview') renderPreviewTable(body);
    else if (state.scan.view === 'scored') renderScoredTable(body, rows);
    else renderQueueTable(body, high.concat(med));

    host.appendChild(viewCard);
  }

  function renderPreviewTable(host) {
    var headers = state.scan.headers;
    var rows = state.scan.rows.slice(0, 120);
    var wrap = el('div', 'table-wrap scroll-y');
    var t = el('table', 'data');
    var thead = el('thead');
    var tr = el('tr');
    headers.forEach(function (h) {
      var th = el('th', null, h);
      var mappedTo = Object.keys(state.scan.mapping).filter(function (k) { return state.scan.mapping[k] === h; })[0];
      if (mappedTo) th.title = 'Mapped to: ' + mappedTo;
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var row = el('tr');
      headers.forEach(function (h) {
        var v = r[h];
        var td = el('td', /^-?[\d.,]+$/.test(String(v)) ? 'n' : null, v === '' ? '—' : String(v));
        if (v === '') td.classList.add('dim');
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    host.appendChild(wrap);
    var note = el('div', 'hint');
    note.style.padding = '10px 16px';
    note.textContent = 'Showing ' + fmtInt(rows.length) + ' of ' + fmtInt(state.scan.rows.length) + ' rows as loaded, before any transformation.';
    host.appendChild(note);
  }

  function renderScoredTable(host, rows) {
    var sorted = rows.slice().sort(function (a, b) { return b.p - a.p; }).slice(0, 300);
    var wrap = el('div', 'table-wrap scroll-y');
    var t = el('table', 'data');
    var thead = el('thead');
    var tr = el('tr');
    ['', 'Transaction', 'Posted', 'Amount', 'Channel', 'Country', 'Risk', 'Band', 'Top driver'].forEach(function (h) {
      tr.appendChild(el('th', null, h));
    });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    sorted.forEach(function (r) {
      var row = el('tr');
      var sc = el('td');
      sc.style.width = '6px';
      sc.style.padding = '0 0 0 12px';
      var st = el('div', 'stripe ' + r.band.stripe);
      sc.appendChild(st);
      row.appendChild(sc);
      row.appendChild(el('td', 'mono', r.meta.txn_id || ('row ' + (r.i + 1))));
      row.appendChild(el('td', 'dim', r.meta.timestamp || '—'));
      row.appendChild(el('td', 'n', fmtMoney(r.meta.amount)));
      row.appendChild(el('td', null, r.meta.channel || '—'));
      row.appendChild(el('td', null, r.meta.country || '—'));
      row.appendChild(el('td', 'n', r.p.toFixed(3)));
      var bd = el('td');
      bd.appendChild(el('span', 'chip ' + r.band.chip, r.band.label));
      row.appendChild(bd);
      row.appendChild(el('td', 'dim', r.drivers[0] ? r.drivers[0].label : '—'));
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    host.appendChild(wrap);
    var note = el('div', 'hint');
    note.style.padding = '10px 16px';
    note.textContent = 'Highest-risk ' + fmtInt(sorted.length) + ' of ' + fmtInt(rows.length) + ' scored rows. Export for the complete set.';
    host.appendChild(note);
  }

  function renderQueueTable(host, flagged) {
    if (!flagged.length) {
      host.appendChild(el('div', 'empty', 'Nothing crossed the medium threshold in this file.'));
      return;
    }
    /* The queue is ordered by expected loss, not raw probability: a 0.9 on a
       $12 transaction is not the first thing an investigator should open. */
    var sorted = flagged.slice().sort(function (a, b) { return b.exposure - a.exposure; }).slice(0, 200);
    var wrap = el('div', 'table-wrap scroll-y');
    var t = el('table', 'data');
    var thead = el('thead');
    var tr = el('tr');
    ['', 'Priority', 'Transaction', 'Account', 'Amount', 'Risk', 'Expected loss', 'Why it flagged', ''].forEach(function (h) {
      tr.appendChild(el('th', null, h));
    });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    sorted.forEach(function (r, rank) {
      var row = el('tr');
      var sc = el('td');
      sc.style.width = '6px';
      sc.style.padding = '0 0 0 12px';
      sc.appendChild(el('div', 'stripe ' + r.band.stripe));
      row.appendChild(sc);
      row.appendChild(el('td', 'n dim', String(rank + 1)));
      row.appendChild(el('td', 'mono', r.meta.txn_id || ('row ' + (r.i + 1))));
      row.appendChild(el('td', 'mono dim', r.meta.account_id || '—'));
      row.appendChild(el('td', 'n', fmtMoney(r.meta.amount)));
      var rk = el('td');
      rk.appendChild(el('span', 'chip ' + r.band.chip, r.p.toFixed(3)));
      row.appendChild(rk);
      row.appendChild(el('td', 'n', fmtMoney(r.exposure)));
      row.appendChild(el('td', 'wrap dim', r.drivers.slice(0, 3).filter(function (d) { return d.value > 0.001; }).map(function (d) { return d.label; }).join(' · ') || 'Composite score'));
      var act = el('td');
      var btn = el('button', 'btn btn-sm', 'Review');
      btn.type = 'button';
      btn.addEventListener('click', function () { openCase(r); });
      act.appendChild(btn);
      row.appendChild(act);
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    host.appendChild(wrap);
    var note = el('div', 'hint');
    note.style.padding = '10px 16px';
    note.textContent = 'Ordered by expected loss (amount × risk). Showing ' + fmtInt(sorted.length) + ' of ' + fmtInt(flagged.length) + ' flagged transactions.';
    host.appendChild(note);
  }

  /* ---------------------------- case review ------------------------------ */

  function openCase(r) {
    var suite = state.fraud;
    var shap = ML.shapValues(suite.ensemble, r.x, suite.background, 80, 3);
    var lime = ML.limeExplain(suite.ensemble, r.x, suite.sigma, { nSamples: 240 }, 5);

    var body = el('div');

    var head = el('div', 'stat-row');
    [['Risk score', r.p.toFixed(3)], ['Band', r.band.label], ['Amount', fmtMoney(r.meta.amount)], ['Expected loss', fmtMoney(r.exposure)]].forEach(function (t) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'stat-label', t[0]));
      s.appendChild(el('div', 'stat-value sm', t[1]));
      head.appendChild(s);
    });
    body.appendChild(head);

    var det = el('div', 'hint');
    det.style.marginTop = '4px';
    det.textContent = [r.meta.txn_id, r.meta.timestamp, r.meta.merchant, r.meta.channel, r.meta.country]
      .filter(Boolean).join('  ·  ');
    body.appendChild(det);

    if (r.meta.memo && state.text) {
      var ts = state.text.score(r.meta.memo);
      if (ts) {
        var tcard = el('div');
        tcard.appendChild(el('div', 'eyebrow', 'Transformer encoder — memo'));
        var line = el('div');
        line.style.margin = '6px 0';
        ts.tokens.forEach(function (tk) {
          var sp = el('span', 'token' + (tk.known ? '' : ' token-unk'), tk.token + ' ');
          var mag = ML.clamp(Math.abs(tk.contribution) * 2.4, 0, 0.85);
          if (tk.known && mag > 0.04) {
            sp.style.background = 'color-mix(in srgb, ' + (tk.contribution > 0 ? 'var(--critical)' : 'var(--s1)') + ' ' + Math.round(mag * 100) + '%, transparent)';
          }
          sp.title = 'logit contribution ' + tk.contribution.toFixed(3) + ' · attention ' + tk.attention.toFixed(3);
          line.appendChild(sp);
        });
        tcard.appendChild(line);
        tcard.appendChild(el('div', 'hint', 'Narrative distress probability ' + ts.p.toFixed(3) + '. Shading is each token’s exact share of the logit; hover for its attention weight.'));
        body.appendChild(tcard);
      }
    }

    var shapWrap = el('div');
    shapWrap.appendChild(el('div', 'eyebrow', 'SHAP — permutation Shapley values, 80 permutations'));
    var shapChart = el('div');
    shapChart.style.marginTop = '8px';
    shapWrap.appendChild(shapChart);
    var shapItems = shap.phi.map(function (v, k) {
      return { label: D.TXN_FEATURES[k].label, value: v, hint: D.TXN_FEATURES[k].hint, detail: fmt(r.x[k], 2) };
    }).sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); }).slice(0, 8);
    renderAttributions(shapChart, shapItems, { unit: 'Shapley value', format: function (v) { return v.toFixed(4); } });
    shapWrap.appendChild(el('div', 'hint', 'Base rate ' + shap.base.toFixed(3) + ' + contributions = ' +
      (shap.base + shap.phi.reduce(function (a, b) { return a + b; }, 0)).toFixed(3) + ' against a model output of ' + r.p.toFixed(3) + '.'));
    body.appendChild(shapWrap);

    var limeWrap = el('div');
    limeWrap.appendChild(el('div', 'eyebrow', 'LIME — local ridge surrogate, R² ' + lime.localFit.toFixed(3)));
    var limeChart = el('div');
    limeChart.style.marginTop = '8px';
    limeWrap.appendChild(limeChart);
    var limeItems = lime.coef.map(function (v, k) {
      return { label: D.TXN_FEATURES[k].label, value: v, hint: 'Risk change per 1 SD move in this feature' };
    }).sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); }).slice(0, 8);
    renderAttributions(limeChart, limeItems, { unit: 'Per 1 SD', format: function (v) { return v.toFixed(4); } });
    body.appendChild(limeWrap);

    var act = el('div');
    act.appendChild(el('div', 'eyebrow', 'Recommended action'));
    var recs = el('div', 'rec-list');
    recs.style.marginTop = '8px';
    fraudActions(r).forEach(function (a) {
      var rec = el('div', 'rec');
      rec.appendChild(el('div', 'stripe ' + a.stripe));
      var txt = el('div');
      txt.appendChild(el('div', 'rec-title', a.title));
      txt.appendChild(el('div', 'rec-body', a.body));
      rec.appendChild(txt);
      recs.appendChild(rec);
    });
    act.appendChild(recs);
    body.appendChild(act);

    openModal('Case ' + (r.meta.txn_id || ('row ' + (r.i + 1))), body);
  }

  /* 07 — prediction to business action: the score resolves into a queue
     decision with a stated reason, not just a number. */
  function fraudActions(r) {
    var out = [];
    var top = r.drivers.filter(function (d) { return d.value > 0.004; }).slice(0, 3);
    if (r.p >= state.fraud.thresholds.high) {
      out.push({
        stripe: 'stripe-critical', title: 'Hold and contact the account holder',
        body: 'Score ' + r.p.toFixed(3) + ' is above the ' + state.fraud.thresholds.high.toFixed(3) +
              ' high-risk threshold, with ' + fmtMoney(r.meta.amount) + ' at stake. Suspend settlement pending verification.'
      });
    } else {
      out.push({
        stripe: 'stripe-warning', title: 'Queue for same-day analyst review',
        body: 'Score ' + r.p.toFixed(3) + ' sits between the medium and high thresholds. Release the payment but review before the account transacts again.'
      });
    }
    top.forEach(function (d) {
      out.push({
        stripe: 'stripe-neutral',
        title: 'Check: ' + d.label,
        body: d.hint + '. This feature added ' + (d.value * 100).toFixed(1) + ' points of risk on the forest path for this transaction.'
      });
    });
    if (r.meta.account_id) {
      out.push({
        stripe: 'stripe-neutral', title: 'Sweep the account',
        body: 'Re-score every transaction on ' + r.meta.account_id + ' from the same file before closing the case — fraud arrives in bursts, not singles.'
      });
    }
    return out;
  }

  function exportScan() {
    var sc = state.scan.scored;
    if (!sc) return;
    var isQueue = state.scan.view === 'queue';
    var rows = isQueue
      ? sc.rows.filter(function (r) { return r.band.key !== 'low'; }).sort(function (a, b) { return b.exposure - a.exposure; })
      : sc.rows.slice().sort(function (a, b) { return b.p - a.p; });

    var out = rows.map(function (r, i) {
      var o = {
        rank: i + 1,
        transaction_id: r.meta.txn_id || ('row_' + (r.i + 1)),
        account_id: r.meta.account_id || '',
        timestamp: r.meta.timestamp || '',
        amount: r.meta.amount.toFixed(2),
        channel: r.meta.channel || '',
        country: r.meta.country || '',
        risk_score: r.p.toFixed(5),
        risk_band: r.band.label,
        expected_loss: r.exposure.toFixed(2),
        driver_1: r.drivers[0] ? r.drivers[0].label : '',
        driver_1_effect: r.drivers[0] ? r.drivers[0].value.toFixed(5) : '',
        driver_2: r.drivers[1] ? r.drivers[1].label : '',
        driver_2_effect: r.drivers[1] ? r.drivers[1].value.toFixed(5) : '',
        driver_3: r.drivers[2] ? r.drivers[2].label : '',
        driver_3_effect: r.drivers[2] ? r.drivers[2].value.toFixed(5) : '',
        scored_at: nowStamp(),
        model: 'RandomForest+GradientBoosting ensemble'
      };
      if (r.meta.label != null) o.known_label = r.meta.label;
      return o;
    });
    openExport((isQueue ? 'investigation_queue_' : 'scored_transactions_') + Date.now() + '.csv', D.objectsToCSV(out), out.length);
  }

  /* ========================= SECTION 2 — HEALTH ========================== */

  var MANUAL_FIELDS = [
    { key: 'annual_revenue', label: 'Annual revenue', unit: 'USD', value: 4200000, step: 10000 },
    { key: 'net_profit', label: 'Net profit', unit: 'USD', value: 268000, step: 5000 },
    { key: 'total_assets', label: 'Total assets', unit: 'USD', value: 3150000, step: 10000 },
    { key: 'total_liabilities', label: 'Total liabilities', unit: 'USD', value: 1980000, step: 10000 },
    { key: 'current_assets', label: 'Current assets', unit: 'USD', value: 1120000, step: 10000 },
    { key: 'current_liabilities', label: 'Current liabilities', unit: 'USD', value: 1040000, step: 10000 },
    { key: 'interest_expense', label: 'Annual interest expense', unit: 'USD', value: 142000, step: 1000 }
  ];

  function readManual() {
    var f = {};
    MANUAL_FIELDS.forEach(function (m) {
      var node = $('fin-' + m.key);
      f[m.key] = node ? D.num(node.value, m.value) : m.value;
    });
    f.cash_reserve_months = $('fin-cash') ? +$('fin-cash').value : 2.8;
    f.revenue_growth_pct = $('fin-growth') ? +$('fin-growth').value : 6;
    return f;
  }

  function renderHealthControls() {
    var host = $('health-controls');
    clear(host);

    var modeCard = el('div', 'card');
    var mh = el('div', 'card-head');
    mh.appendChild(el('h3', null, 'Input method'));
    modeCard.appendChild(mh);
    var seg = el('div', 'seg');
    [['manual', 'Type figures'], ['csv', 'Upload CSV']].forEach(function (m) {
      var b = el('button', null, m[1]);
      b.type = 'button';
      b.setAttribute('aria-selected', state.health.mode === m[0] ? 'true' : 'false');
      b.addEventListener('click', function () { state.health.mode = m[0]; renderHealthControls(); renderHealthResults(); });
      seg.appendChild(b);
    });
    modeCard.appendChild(seg);
    modeCard.appendChild(el('div', 'hint', state.health.mode === 'manual'
      ? 'Enter one company’s figures. Everything recalculates as you type.'
      : 'Upload a file of companies and score the whole portfolio at once.'));
    host.appendChild(modeCard);

    if (state.health.mode === 'manual') renderManualForm(host);
    else renderHealthUpload(host);
  }

  function renderManualForm(host) {
    var card = el('div', 'card');
    var ch = el('div', 'card-head');
    ch.appendChild(el('h3', null, 'Financial inputs'));
    card.appendChild(ch);

    var grid = el('div', 'stack');
    MANUAL_FIELDS.forEach(function (m) {
      var f = el('div', 'field');
      var lab = el('label');
      lab.setAttribute('for', 'fin-' + m.key);
      lab.appendChild(document.createTextNode(m.label));
      lab.appendChild(el('span', 'field-unit', m.unit));
      f.appendChild(lab);
      var inp = el('input');
      inp.type = 'number';
      inp.id = 'fin-' + m.key;
      inp.value = m.value;
      inp.step = m.step;
      inp.addEventListener('input', scheduleHealth);
      f.appendChild(inp);
      grid.appendChild(f);
    });

    var cashF = el('div', 'field');
    var cashL = el('label');
    cashL.setAttribute('for', 'fin-cash');
    cashL.appendChild(document.createTextNode('Cash reserve'));
    var cashV = el('span', 'field-unit', '2.8 months');
    cashV.id = 'fin-cash-val';
    cashL.appendChild(cashV);
    cashF.appendChild(cashL);
    var cash = el('input');
    cash.type = 'range';
    cash.id = 'fin-cash';
    cash.min = 0; cash.max = 18; cash.step = 0.1; cash.value = 2.8;
    cash.addEventListener('input', function () {
      cashV.textContent = (+cash.value).toFixed(1) + ' months';
      scheduleHealth();
    });
    cashF.appendChild(cash);
    grid.appendChild(cashF);

    var grF = el('div', 'field');
    var grL = el('label');
    grL.setAttribute('for', 'fin-growth');
    grL.appendChild(document.createTextNode('Revenue growth (YoY)'));
    var grV = el('span', 'field-unit', '+6.0%');
    grV.id = 'fin-growth-val';
    grL.appendChild(grV);
    grF.appendChild(grL);
    var gr = el('input');
    gr.type = 'range';
    gr.id = 'fin-growth';
    gr.min = -50; gr.max = 80; gr.step = 0.5; gr.value = 6;
    gr.addEventListener('input', function () {
      grV.textContent = (gr.value > 0 ? '+' : '') + (+gr.value).toFixed(1) + '%';
      scheduleHealth();
    });
    grF.appendChild(gr);
    grid.appendChild(grF);

    var noteF = el('div', 'field');
    var noteL = el('label');
    noteL.setAttribute('for', 'fin-note');
    noteL.appendChild(document.createTextNode('Management commentary'));
    noteL.appendChild(el('span', 'field-unit', 'optional'));
    noteF.appendChild(noteL);
    var note = el('textarea');
    note.id = 'fin-note';
    note.rows = 3;
    note.placeholder = 'Paste board notes, audit remarks or credit-committee commentary…';
    note.value = 'Covenant waiver requested from lenders and supplier payments delayed beyond terms, although gross margin expanded on pricing discipline.';
    note.addEventListener('input', scheduleHealth);
    noteF.appendChild(note);
    grid.appendChild(noteF);

    card.appendChild(grid);

    var btn = el('button', 'btn btn-primary btn-block', 'Calculate health score');
    btn.type = 'button';
    btn.style.marginTop = '12px';
    btn.addEventListener('click', computeHealth);
    card.appendChild(btn);
    host.appendChild(card);
  }

  var healthTimer = null;
  function scheduleHealth() {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(computeHealth, 220);
  }

  function renderHealthUpload(host) {
    var card = el('div', 'card');
    var ch = el('div', 'card-head');
    ch.appendChild(el('h3', null, 'Financials file'));
    card.appendChild(ch);

    var dz = el('div', 'dropzone');
    dz.setAttribute('role', 'button');
    dz.setAttribute('tabindex', '0');
    dz.appendChild(el('div', 'dropzone-title', 'Drop a financials CSV'));
    dz.appendChild(el('div', 'dropzone-sub', 'one row per company'));
    var fi = el('input');
    fi.type = 'file';
    fi.id = 'health-file';
    fi.accept = '.csv,text/csv,text/plain';
    fi.className = 'sr-only';
    dz.addEventListener('click', function () { fi.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer.files[0]) readHealthFile(e.dataTransfer.files[0]);
    });
    fi.addEventListener('change', function () { if (fi.files[0]) readHealthFile(fi.files[0]); });
    card.appendChild(dz);
    card.appendChild(fi);

    var br = el('div', 'btn-row');
    br.style.marginTop = '10px';
    var sample = el('button', 'btn btn-sm', 'Load sample file');
    sample.type = 'button';
    sample.addEventListener('click', loadSampleFinancials);
    br.appendChild(sample);
    card.appendChild(br);
    host.appendChild(card);

    var mapCard = el('div', 'card');
    var mh = el('div', 'card-head');
    mh.appendChild(el('h3', null, 'Column mapping'));
    var cov = D.mappingCoverage(state.health.mapping, D.FIN_FIELDS);
    mh.appendChild(el('span', 'card-note', cov.mapped + ' of ' + cov.total + ' detected'));
    mapCard.appendChild(mh);

    if (!state.health.headers.length) {
      mapCard.appendChild(el('div', 'hint', 'Load a file to map its columns.'));
    } else {
      var list = el('div', 'map-list');
      D.FIN_FIELDS.forEach(function (f) {
        var row = el('div', 'map-row');
        var lab = el('div', 'map-label');
        lab.appendChild(document.createTextNode(f.label));
        if (f.required) lab.appendChild(el('span', 'map-req', 'REQ'));
        row.appendChild(lab);
        var sel = el('select');
        sel.id = 'map-fin-' + f.key;
        var none = el('option', null, '— not mapped —');
        none.value = '';
        sel.appendChild(none);
        state.health.headers.forEach(function (h) {
          var o = el('option', null, h);
          o.value = h;
          if (state.health.mapping[f.key] === h) o.selected = true;
          sel.appendChild(o);
        });
        if (!state.health.mapping[f.key]) sel.classList.add('unmapped');
        sel.addEventListener('change', function () {
          if (sel.value) state.health.mapping[f.key] = sel.value;
          else delete state.health.mapping[f.key];
          renderHealthControls();
        });
        row.appendChild(sel);
        list.appendChild(row);
      });
      mapCard.appendChild(list);

      if (cov.missingRequired.length) {
        var w = el('div', 'banner banner-bad');
        w.style.marginTop = '10px';
        w.innerHTML = '<span><b>Map ' + cov.missingRequired.join(', ') + '</b> to score this file.</span>';
        mapCard.appendChild(w);
      }
      var run = el('button', 'btn btn-primary btn-block', 'Analyse portfolio');
      run.type = 'button';
      run.style.marginTop = '12px';
      run.disabled = cov.missingRequired.length > 0;
      run.addEventListener('click', runPortfolio);
      mapCard.appendChild(run);
    }
    host.appendChild(mapCard);
  }

  function readHealthFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = D.parseCSV(reader.result);
      if (!parsed.headers.length) { alert('That file has no readable header row.'); return; }
      state.health.rows = parsed.rows;
      state.health.headers = parsed.headers;
      state.health.mapping = D.autoMap(parsed.headers, D.FIN_FIELDS);
      state.health.portfolio = null;
      renderHealthControls();
      var cov = D.mappingCoverage(state.health.mapping, D.FIN_FIELDS);
      if (!cov.missingRequired.length) runPortfolio();
      else renderHealthResults();
    };
    reader.readAsText(file);
  }

  function loadSampleFinancials() {
    var rows = D.generateCompanies(220, 4242).map(function (r) {
      return {
        'Entity': r.company_name, 'Industry': r.sector,
        'Turnover FY': r.annual_revenue, 'PAT': r.net_profit,
        'Asset Total': r.total_assets, 'Liability Total': r.total_liabilities,
        'Curr Assets': r.current_assets, 'Curr Liabilities': r.current_liabilities,
        'Cash Runway (mo)': r.cash_reserve_months, 'YoY Growth %': r.revenue_growth_pct,
        'Finance Cost': r.interest_expense
      };
    });
    state.health.rows = rows;
    state.health.headers = Object.keys(rows[0]);
    state.health.mapping = D.autoMap(state.health.headers, D.FIN_FIELDS);
    state.health.portfolio = null;
    renderHealthControls();
    runPortfolio();
  }

  function runPortfolio() {
    if (!state.business) return;
    var m = state.health.mapping;
    var suite = state.business;
    var run = timed(function () {
      return state.health.rows.map(function (row, i) {
        var f = {};
        D.FIN_FIELDS.forEach(function (fd) {
          if (m[fd.key]) f[fd.key] = row[m[fd.key]];
        });
        var built = D.financialsToFeatures(f);
        var hs = D.healthScore(built.ratios);
        var p = suite.ensemble(built.vector);
        return {
          i: i,
          name: m.company_name ? row[m.company_name] : ('Company ' + (i + 1)),
          sector: m.sector ? row[m.sector] : '',
          score: hs.total, grade: hs.grade, pillars: hs.pillars,
          p: p, ratios: built.ratios, vector: built.vector
        };
      });
    });

    logRun({
      job: 'score', dataset: 'financials upload',
      model: 'RF + XGBoost ensemble + four-pillar score',
      rows: run.out.length, features: 10,
      params: { pillars: 4, weightPerPillar: 25 },
      ms: run.ms,
      metrics: {
        meanScore: ML.mean(run.out.map(function (r) { return r.score; })),
        meanFailureProb: ML.mean(run.out.map(function (r) { return r.p; }))
      }
    });

    state.health.portfolio = { rows: run.out, ms: run.ms };
    renderHealthResults();
  }

  function computeHealth() {
    if (!state.business) return;
    var f = readManual();
    var built = D.financialsToFeatures(f);
    var hs = D.healthScore(built.ratios);
    var suite = state.business;

    var run = timed(function () {
      return {
        rf: suite.rf.predictProba(built.vector),
        gbt: suite.gbt.predictProba(built.vector),
        lr: suite.lr.predictProba(built.vector)
      };
    });
    var probs = run.out;
    probs.ensemble = (probs.rf + probs.gbt) / 2;

    var shap = ML.shapValues(suite.ensemble, built.vector, suite.background, 80, 3);
    var lime = ML.limeExplain(suite.ensemble, built.vector, suite.sigma, { nSamples: 240 }, 5);

    var noteNode = $('fin-note');
    var textResult = (noteNode && noteNode.value.trim() && state.text) ? state.text.score(noteNode.value) : null;

    logRun({
      job: 'score', dataset: 'manual entry',
      model: 'RF + XGBoost + LogReg + four-pillar score',
      rows: 1, features: built.vector.length,
      params: { shapPermutations: 80, limeSamples: 240, textEncoder: !!textResult },
      ms: run.ms,
      metrics: { healthScore: hs.total, failureProb: probs.ensemble }
    });

    state.health.result = {
      financials: f, ratios: built.ratios, vector: built.vector,
      health: hs, probs: probs, shap: shap, lime: lime, text: textResult
    };
    renderHealthResults();
  }

  function riskLevelOf(p) {
    if (p >= 0.45) return { label: 'Critical', chip: 'chip-critical', stripe: 'stripe-critical' };
    if (p >= 0.25) return { label: 'Elevated', chip: 'chip-serious', stripe: 'stripe-serious' };
    if (p >= 0.12) return { label: 'Watch', chip: 'chip-warning', stripe: 'stripe-warning' };
    return { label: 'Stable', chip: 'chip-good', stripe: 'stripe-good' };
  }

  function renderHealthResults() {
    var host = $('health-results');
    clear(host);
    if (state.health.mode === 'csv') { renderPortfolio(host); return; }

    var r = state.health.result;
    if (!r) { host.appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Enter the figures to calculate a score.')); return; }

    var risk = riskLevelOf(r.probs.ensemble);

    /* headline: score ring + pillars */
    var top = el('div', 'card');
    var th = el('div', 'card-head');
    th.appendChild(el('h3', null, 'Business health score'));
    th.appendChild(el('span', 'chip ' + risk.chip, risk.label + ' risk'));
    top.appendChild(th);

    var gw = el('div', 'gauge-wrap');
    var gauge = el('div', 'gauge');
    gw.appendChild(gauge);
    renderGauge(gauge, r.health.total, r.health.grade);

    var right = el('div');
    right.style.flex = '1 1 260px';
    right.style.minWidth = '240px';
    var pillars = el('div', 'stack');
    r.health.pillars.forEach(function (p) {
      var bl = el('div', 'barline');
      var hd = el('div', 'barline-head');
      hd.appendChild(el('span', null, p.label));
      hd.appendChild(el('span', 'v', p.score.toFixed(1) + ' / 25'));
      bl.appendChild(hd);
      var track = el('div', 'bartrack');
      var fill = el('div', 'barfill');
      fill.style.width = (p.score / 25 * 100) + '%';
      fill.style.background = p.score >= 18 ? 'var(--good)' : (p.score >= 11 ? 'var(--s1)' : (p.score >= 6 ? 'var(--warning)' : 'var(--critical)'));
      track.appendChild(fill);
      bl.appendChild(track);
      bl.appendChild(el('div', 'hint', p.detail));
      pillars.appendChild(bl);
    });
    right.appendChild(pillars);
    gw.appendChild(right);

    var scale = el('div', 'grade-scale');
    [['excellent', 'Excellent', 90], ['strong', 'Strong', 75], ['good', 'Good', 60], ['fair', 'Fair', 40], ['weak', 'Needs improvement', 0]].forEach(function (g) {
      var d = el('div', r.health.grade.key === g[0] ? 'on' : null);
      var dot = el('span', 'grade-dot');
      dot.style.background = GRADE_COLOUR[g[0]];
      d.appendChild(dot);
      d.appendChild(document.createTextNode(g[1] + '  ' + (g[2] ? g[2] + '+' : '< 40')));
      scale.appendChild(d);
    });
    gw.appendChild(scale);
    top.appendChild(gw);
    host.appendChild(top);

    /* model panel */
    var tiles = el('div', 'stat-row');
    [
      ['Failure probability', fmtPct(r.probs.ensemble, 1), 'RF + XGBoost, 24-month horizon'],
      ['Random Forest', fmtPct(r.probs.rf, 1), state.business.rf.trees.length + ' trees'],
      ['XGBoost', fmtPct(r.probs.gbt, 1), state.business.gbt.trees.length + ' rounds'],
      ['Logistic baseline', fmtPct(r.probs.lr, 1), 'Interpretable reference'],
      ['Net worth', fmtMoney(r.ratios.net_worth), 'Assets − liabilities'],
      ['Debt / assets', fmtPct(r.ratios.debt_to_assets, 0), 'Coverage ' + r.ratios.coverage.toFixed(1) + '×']
    ].forEach(function (t) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'stat-label', t[0]));
      s.appendChild(el('div', 'stat-value sm', t[1]));
      s.appendChild(el('div', 'stat-meta', t[2]));
      tiles.appendChild(s);
    });
    host.appendChild(tiles);

    /* interpretation */
    var interp = el('div', 'card');
    var ih = el('div', 'card-head');
    ih.appendChild(el('h3', null, 'Risk interpretation'));
    interp.appendChild(ih);
    interpretation(r).forEach(function (para) {
      var p = el('p');
      p.style.marginTop = '8px';
      p.style.color = 'var(--ink-2)';
      p.style.maxWidth = '68ch';
      p.innerHTML = para;
      interp.appendChild(p);
    });
    host.appendChild(interp);

    /* drivers */
    var dr = el('div', 'card');
    var dh = el('div', 'card-head');
    dh.appendChild(el('h3', null, 'Key drivers'));
    dh.appendChild(el('span', 'card-note', 'SHAP · ' + r.shap.nPerm + ' permutations   |   LIME R² ' + r.lime.localFit.toFixed(2)));
    dr.appendChild(dh);

    var cols = el('div');
    cols.style.display = 'grid';
    cols.style.gap = '18px';
    cols.style.gridTemplateColumns = 'repeat(auto-fit, minmax(280px, 1fr))';

    var shapCol = el('div');
    shapCol.appendChild(el('div', 'eyebrow', 'SHAP — effect on failure probability'));
    var sc = el('div');
    sc.style.marginTop = '8px';
    shapCol.appendChild(sc);
    renderAttributions(sc, r.shap.phi.map(function (v, k) {
      return { label: D.FIN_FEATURES[k].label, value: v, hint: D.FIN_FEATURES[k].hint, detail: fmt(r.vector[k], 2) };
    }).sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); }), { unit: 'Shapley value', format: function (v) { return v.toFixed(4); } });
    cols.appendChild(shapCol);

    var limeCol = el('div');
    limeCol.appendChild(el('div', 'eyebrow', 'LIME — local surrogate, per 1 SD'));
    var lc = el('div');
    lc.style.marginTop = '8px';
    limeCol.appendChild(lc);
    renderAttributions(lc, r.lime.coef.map(function (v, k) {
      return { label: D.FIN_FEATURES[k].label, value: v, hint: D.FIN_FEATURES[k].hint };
    }).sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); }), { unit: 'Per 1 SD', format: function (v) { return v.toFixed(4); } });
    cols.appendChild(limeCol);

    dr.appendChild(cols);
    dr.appendChild(el('div', 'hint', 'Red pushes failure probability up, blue pulls it down. SHAP attributes the whole prediction; LIME fits a straight line to the model in this company’s immediate neighbourhood.'));
    host.appendChild(dr);

    /* transformer narrative */
    if (r.text) {
      var tc = el('div', 'card');
      var tch = el('div', 'card-head');
      tch.appendChild(el('h3', null, 'Narrative signal'));
      tch.appendChild(el('span', 'card-note', 'Transformer encoder · ' + r.text.vocabSize + ' token vocabulary'));
      tc.appendChild(tch);

      var line = el('div');
      line.style.lineHeight = '2';
      r.text.tokens.forEach(function (tk) {
        var sp = el('span', 'token' + (tk.known ? '' : ' token-unk'), tk.token + ' ');
        var mag = ML.clamp(Math.abs(tk.contribution) * 2.4, 0, 0.85);
        if (tk.known && mag > 0.04) {
          sp.style.background = 'color-mix(in srgb, ' + (tk.contribution > 0 ? 'var(--critical)' : 'var(--s1)') + ' ' + Math.round(mag * 100) + '%, transparent)';
        }
        sp.title = 'logit contribution ' + tk.contribution.toFixed(3) + ' · attention received ' + tk.attention.toFixed(3);
        line.appendChild(sp);
      });
      tc.appendChild(line);

      var trow = el('div', 'stat-row');
      trow.style.marginTop = '12px';
      [['Narrative distress probability', fmtPct(r.text.p, 1)],
       ['Structured model', fmtPct(r.probs.ensemble, 1)],
       ['Blended view', fmtPct(0.75 * r.probs.ensemble + 0.25 * r.text.p, 1)]].forEach(function (t) {
        var s = el('div', 'stat');
        s.appendChild(el('div', 'stat-label', t[0]));
        s.appendChild(el('div', 'stat-value sm', t[1]));
        trow.appendChild(s);
      });
      tc.appendChild(trow);
      tc.appendChild(el('div', 'hint', 'The encoder is trained only on narrative, so it is reported beside the structured models at a fixed 25% weight rather than folded into them silently. Shading is each token’s exact share of the logit.'));
      host.appendChild(tc);
    }

    /* recommendations */
    var rc = el('div', 'card');
    var rh = el('div', 'card-head');
    rh.appendChild(el('h3', null, 'Recommendations'));
    rh.appendChild(el('span', 'card-note', 'Ordered by impact on the weakest pillar'));
    rc.appendChild(rh);
    var rl = el('div', 'rec-list');
    recommendations(r).forEach(function (rec) {
      var n = el('div', 'rec');
      n.appendChild(el('div', 'stripe ' + rec.stripe));
      var t = el('div');
      t.appendChild(el('div', 'rec-title', rec.title));
      t.appendChild(el('div', 'rec-body', rec.body));
      t.style.flex = '1';
      n.appendChild(t);
      rl.appendChild(n);
    });
    rc.appendChild(rl);
    host.appendChild(rc);
  }

  function interpretation(r) {
    var out = [];
    var ra = r.ratios, hs = r.health, p = r.probs.ensemble;
    var weakest = hs.pillars.slice().sort(function (a, b) { return a.score - b.score; })[0];
    var strongest = hs.pillars.slice().sort(function (a, b) { return b.score - a.score; })[0];

    out.push('The business scores <b>' + hs.total.toFixed(1) + ' out of 100</b> — <b>' + hs.grade.label.toLowerCase() +
      '</b>. Strength sits in <b>' + strongest.label.toLowerCase() + '</b> (' + strongest.score.toFixed(1) +
      '/25); the binding constraint is <b>' + weakest.label.toLowerCase() + '</b> at ' + weakest.score.toFixed(1) + '/25.');

    out.push('Separately from the ratio score, the tree ensemble puts the probability of financial distress within 24 months at <b>' +
      fmtPct(p, 1) + '</b>. The Random Forest reads ' + fmtPct(r.probs.rf, 1) + ' and the gradient-boosted model ' +
      fmtPct(r.probs.gbt, 1) + '; the logistic baseline, which cannot represent interactions between leverage and runway, reads ' +
      fmtPct(r.probs.lr, 1) + '.');

    var notes = [];
    if (ra.debt_to_assets > 0.65) notes.push('leverage at ' + fmtPct(ra.debt_to_assets, 0) + ' of assets is above the level where the model starts treating cash runway as the deciding variable');
    if (ra.cash_months < 3) notes.push('a ' + ra.cash_months.toFixed(1) + '-month cash runway leaves little room to absorb a shock');
    if (ra.current_ratio < 1) notes.push('current liabilities exceed current assets, so short-term obligations depend on new inflows');
    if (ra.coverage < 2) notes.push('interest cover of ' + ra.coverage.toFixed(1) + '× means earnings barely clear the financing bill');
    if (ra.net_margin < 0.02) notes.push('a ' + fmtPct(ra.net_margin, 1) + ' net margin gives almost no buffer for price or cost movement');
    if (ra.growth < 0) notes.push('revenue is contracting at ' + fmtPct(Math.abs(ra.growth), 1) + ' a year');
    if (ra.cash_months > 6 && ra.debt_to_assets < 0.4) notes.push('the combination of a ' + ra.cash_months.toFixed(1) + '-month runway and modest leverage is the single strongest protective pattern in the training data');
    if (ra.net_margin > 0.12) notes.push('a ' + fmtPct(ra.net_margin, 1) + ' margin gives real capacity to absorb cost shocks');

    if (notes.length) out.push('What the figures say: ' + notes.join('; ') + '.');
    return out;
  }

  /* 07 — every recommendation carries the number that closes the gap. */
  function recommendations(r) {
    var ra = r.ratios, out = [];
    var monthlyOpex = Math.max(1, (ra.revenue - ra.profit) / 12);

    if (ra.debt_to_assets > 0.55) {
      var target = ra.liabilities - 0.5 * ra.assets;
      out.push({
        stripe: ra.debt_to_assets > 0.72 ? 'stripe-critical' : 'stripe-serious',
        title: 'Bring leverage below 50% of assets',
        body: 'Debt-to-assets is ' + fmtPct(ra.debt_to_assets, 0) + '. Retiring ' + fmtMoney(target) +
              ' of liabilities — or adding the same in equity — reaches the 50% line, which is where the model stops pairing leverage with runway as a failure signal.'
      });
    }
    if (ra.cash_months < 6) {
      out.push({
        stripe: ra.cash_months < 2 ? 'stripe-critical' : 'stripe-warning',
        title: 'Extend the cash runway to six months',
        body: 'At ' + fmtMoney(monthlyOpex) + ' of monthly operating cost, the runway is ' + ra.cash_months.toFixed(1) +
              ' months. Holding ' + fmtMoney((6 - ra.cash_months) * monthlyOpex) + ' more in reserve reaches six months and adds ' +
              (0.6 * (Math.min(6, 6) - ra.cash_months) / 6 * 25).toFixed(1) + ' points to the liquidity pillar.'
      });
    }
    if (ra.current_ratio < 1.3) {
      var need = 1.3 * ra.current_liabilities - ra.current_assets;
      out.push({
        stripe: ra.current_ratio < 1 ? 'stripe-serious' : 'stripe-warning',
        title: 'Rebuild working capital',
        body: 'Current ratio is ' + ra.current_ratio.toFixed(2) + '. Converting ' + fmtMoney(need) +
              ' of receivables or inventory into cash — or terming out the same amount of payables — reaches a 1.3 ratio.'
      });
    }
    if (ra.net_margin < 0.06) {
      var gap = (0.06 - ra.net_margin) * ra.revenue;
      out.push({
        stripe: ra.net_margin < 0 ? 'stripe-critical' : 'stripe-warning',
        title: 'Close the margin gap',
        body: 'Net margin is ' + fmtPct(ra.net_margin, 1) + '. Finding ' + fmtMoney(gap) +
              ' of annual cost reduction or price recovery reaches a 6% margin, the level where profitability stops dragging the score down.'
      });
    }
    if (ra.growth < 0.03) {
      out.push({
        stripe: ra.growth < -0.1 ? 'stripe-serious' : 'stripe-warning',
        title: 'Address the revenue trend',
        body: 'Growth is ' + fmtPct(ra.growth, 1) + '. The models weight a contracting top line most heavily when margin is also thin, which is ' +
              (ra.net_margin < 0.05 ? 'the case here — this pairing is the second-strongest failure pattern in the training data.' : 'not the case here, so the immediate risk is contained.')
      });
    }
    if (ra.coverage < 2.5 && ra.interest_expense > 0) {
      out.push({
        stripe: ra.coverage < 1.5 ? 'stripe-critical' : 'stripe-warning',
        title: 'Reduce the financing burden',
        body: 'Interest cover is ' + ra.coverage.toFixed(1) + '×. Refinancing to cut ' +
              fmtMoney(ra.interest_expense - (ra.profit + ra.interest_expense) / 3) + ' of annual interest would lift cover to 3×.'
      });
    }

    if (!out.length) {
      out.push({
        stripe: 'stripe-good',
        title: 'Hold the current position',
        body: 'Every pillar clears its threshold and the ensemble puts failure probability at ' + fmtPct(r.probs.ensemble, 1) +
              '. Re-run this quarterly; the earliest warning in the training data is a runway falling below three months while leverage climbs.'
      });
    }
    out.push({
      stripe: 'stripe-neutral',
      title: 'Re-score on the next reporting cycle',
      body: 'This score reflects one point in time. The models were trained on 24-month outcomes, so quarter-on-quarter movement in the weakest pillar is the signal to watch.'
    });
    return out;
  }

  function renderPortfolio(host) {
    var pf = state.health.portfolio;
    if (!pf) {
      host.appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Load a financials file to score a portfolio.'));
      return;
    }
    var rows = pf.rows;
    var atRisk = rows.filter(function (r) { return r.p >= 0.25; });
    var weak = rows.filter(function (r) { return r.score < 40; });

    var tiles = el('div', 'stat-row');
    [
      ['Companies', fmtInt(rows.length), 'Scored in ' + pf.ms.toFixed(0) + ' ms'],
      ['Average score', ML.mean(rows.map(function (r) { return r.score; })).toFixed(1), 'out of 100'],
      ['Elevated or worse', fmtInt(atRisk.length), fmtPct(atRisk.length / rows.length) + ' of portfolio'],
      ['Needs improvement', fmtInt(weak.length), 'Score below 40'],
      ['Mean failure prob.', fmtPct(ML.mean(rows.map(function (r) { return r.p; })), 1), '24-month horizon']
    ].forEach(function (t) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'stat-label', t[0]));
      s.appendChild(el('div', 'stat-value sm', t[1]));
      s.appendChild(el('div', 'stat-meta', t[2]));
      tiles.appendChild(s);
    });
    host.appendChild(tiles);

    var card = el('div', 'card flush');
    var ch = el('div', 'card-head');
    ch.style.padding = '14px 16px 0';
    ch.appendChild(el('h3', null, 'Portfolio'));
    var exp = el('button', 'btn btn-sm', 'Export');
    exp.type = 'button';
    exp.addEventListener('click', function () {
      openExport('portfolio_health_' + Date.now() + '.csv', D.objectsToCSV(rows.map(function (r) {
        return {
          company: r.name, sector: r.sector,
          health_score: r.score.toFixed(1), grade: r.grade.label,
          profitability: r.pillars[0].score.toFixed(1),
          liquidity: r.pillars[1].score.toFixed(1),
          solvency: r.pillars[2].score.toFixed(1),
          growth: r.pillars[3].score.toFixed(1),
          failure_probability: r.p.toFixed(5),
          risk_level: riskLevelOf(r.p).label,
          net_margin: r.ratios.net_margin.toFixed(4),
          debt_to_assets: r.ratios.debt_to_assets.toFixed(4),
          current_ratio: r.ratios.current_ratio.toFixed(3),
          cash_months: r.ratios.cash_months.toFixed(2),
          scored_at: nowStamp()
        };
      })), rows.length);
    });
    ch.appendChild(exp);
    card.appendChild(ch);

    var wrap = el('div', 'table-wrap scroll-y');
    wrap.style.marginTop = '12px';
    var t = el('table', 'data');
    var thead = el('thead');
    var tr = el('tr');
    ['', 'Company', 'Sector', 'Score', 'Grade', 'Profit', 'Liquid', 'Solvent', 'Growth', 'Failure prob.', 'Risk'].forEach(function (h) {
      tr.appendChild(el('th', null, h));
    });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    rows.slice().sort(function (a, b) { return a.score - b.score; }).slice(0, 250).forEach(function (r) {
      var risk = riskLevelOf(r.p);
      var row = el('tr');
      var sc = el('td');
      sc.style.width = '6px';
      sc.style.padding = '0 0 0 12px';
      sc.appendChild(el('div', 'stripe ' + risk.stripe));
      row.appendChild(sc);
      row.appendChild(el('td', null, r.name));
      row.appendChild(el('td', 'dim', r.sector || '—'));
      row.appendChild(el('td', 'n', r.score.toFixed(1)));
      row.appendChild(el('td', 'dim', r.grade.label));
      r.pillars.forEach(function (p) { row.appendChild(el('td', 'n dim', p.score.toFixed(1))); });
      row.appendChild(el('td', 'n', fmtPct(r.p, 1)));
      var rk = el('td');
      rk.appendChild(el('span', 'chip ' + risk.chip, risk.label));
      row.appendChild(rk);
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    card.appendChild(wrap);
    var note = el('div', 'hint');
    note.style.padding = '10px 16px';
    note.textContent = 'Weakest ' + fmtInt(Math.min(250, rows.length)) + ' of ' + fmtInt(rows.length) + ' companies, worst first.';
    card.appendChild(note);
    host.appendChild(card);
  }

  /* ======================= SECTION 3 — METHODOLOGY ====================== */

  var METHODS = [
    {
      n: '01', title: 'Random Forest', kind: 'Core research method',
      body: [
        'A forest of decision trees, each grown on a bootstrap resample of the training rows and allowed to consider only a random <code>sqrt(d)</code> subset of features at every split. Because each tree sees different rows and different columns, their errors are only weakly correlated, and averaging their votes cancels most of the variance a single deep tree would carry.',
        'The value for risk work is that a tree partitions the feature space rather than fitting a surface through it. A rule like <em>cross-border AND card-not-present AND amount well above this account’s norm</em> is three nested splits — a conjunction the model represents exactly. A linear model can only add those effects up, which is why it under-prices exactly the combinations that matter.',
        'Every split threshold here is found by an exact sorted scan over all valid cut points, and each tree is scored on the rows its bootstrap left out, giving an honest out-of-bag estimate before the test split is ever touched.'
      ]
    },
    {
      n: '02', title: 'XGBoost / gradient-boosted trees', kind: 'Core research method',
      body: [
        'Where the forest averages independent trees, boosting grows them in sequence: each new tree is fitted to what the ensemble still gets wrong. This implementation uses the XGBoost objective directly — the first and second derivatives of the logistic loss, <code>g = p − y</code> and <code>h = p(1−p)</code>, are computed per row each round, and a split is only taken when it improves the regularised structure score.',
        'The split criterion is <code>gain = ½[G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ)] − γ</code>, and each leaf takes the weight <code>w = −G/(H+λ)</code> that minimises the second-order approximation. Shrinkage, row subsampling and column subsampling keep the sequence from memorising the training set.',
        'Boosted trees typically edge out the forest on ranking quality because later trees specialise in the hard region near the decision boundary, which is precisely the region a fraud queue lives in.'
      ]
    },
    {
      n: '03', title: 'Logistic regression', kind: 'Interpretable baseline',
      body: [
        'A standardised, L2-penalised logistic model fitted by gradient descent. It estimates the probability of fraud or failure as a single weighted sum, so every coefficient is an odds ratio a credit committee or a regulator can read straight off the page.',
        'It is kept for two reasons. First, it is the honest control: if the ensembles cannot beat a straight line on held-out data, their complexity is not paying for itself. Second, when the ensembles do win, the size of the gap measures exactly how much of the risk lives in interactions rather than in main effects.'
      ]
    },
    {
      n: '04', title: 'Transformer-based NLP', kind: 'Unstructured signal',
      body: [
        'Financial distress is often written down before it shows up in a ratio. Covenant waivers, going-concern language and stretched supplier terms appear in board packs and audit letters quarters ahead of the balance sheet.',
        'A single transformer encoder block turns that text into a number. Tokens become learned embeddings, sinusoidal positions are added, and one head of scaled dot-product self-attention lets every token be re-weighted by its context — which is how <em>despite</em> and <em>although</em> change the reading of the clause that follows them. A residual connection, mean pooling and a linear head produce the distress probability, and the whole block is trained by backpropagation through the softmax.',
        'Because pooling is a mean, each token supplies exactly <code>(w · R_i)/n</code> of the final logit. That makes the highlighting in Section 2 an exact decomposition rather than a heat-map impression.'
      ]
    },
    {
      n: '05', title: 'SHAP and LIME explainability', kind: 'Attribution',
      body: [
        'SHAP answers what each feature contributed to <em>this</em> prediction. Features are revealed in random order over a background sample and the marginal change each reveal causes is averaged across permutations, which is the Shapley value from cooperative game theory. It satisfies local accuracy: the base rate plus the contributions reconstructs the model output.',
        'LIME answers a different question — what the model looks like <em>around</em> this case. It samples a neighbourhood, weights each sample by proximity and fits a ridge regression to the model’s responses. Its local R² is reported alongside, because a surrogate that fits badly is a surrogate that should not be quoted.',
        'For bulk scoring the platform uses an exact path decomposition instead: walking each tree and attributing every change in node value to the feature that caused it. It is cheap enough to run on every row of a file, which is why the queue can name a reason for each flag.'
      ]
    },
    {
      n: '06', title: 'Model evaluation', kind: 'Validation',
      body: [
        'Every number in the leaderboard below is computed on a held-out 30% split that no model saw during fitting. ROC-AUC is rank-based with tie correction; precision, recall, F1, accuracy and specificity are read off the confusion matrix at a stated threshold.',
        'The hyperparameters are fixed conservative defaults — shallow trees, a low learning rate, a real L2 penalty — chosen because that is what a rare positive class asks for. They were deliberately <em>not</em> selected by scoring the test split, which would quietly leak it into every figure reported here. The sliders at the bottom of this section let you tune them yourself and watch what happens.',
        'The deployed threshold is the one that maximises F1 on that split, not a default of 0.5 — at a base rate near 4%, a 0.5 cut-off produces a model that looks 96% accurate and catches almost nothing. Move the slider under the confusion matrix and the whole precision/recall trade-off moves with it.'
      ]
    },
    {
      n: '07', title: 'Prediction to business action', kind: 'Deployment',
      body: [
        'A probability is not a decision. In Section 1 the score becomes a queue ordered by expected loss — amount × probability — because a 0.9 on a small ticket should not outrank a 0.6 on a large one, and each case carries the features that drove it plus a recommended disposition.',
        'In Section 2 the same machinery becomes a score out of 100, a written interpretation, and recommendations that carry the figure that closes the gap: the debt to retire, the reserve to build, the margin points to recover.',
        'The run log below is the audit trail. Every fit and every scoring batch this session has performed is recorded with its hyperparameters, row counts, metrics and wall-clock latency, and exports as JSON.'
      ]
    }
  ];

  function renderMethodology() {
    var host = $('method-body');
    clear(host);
    if (!state.fraud || !state.business) return;

    var f = state.fraud, b = state.business;

    /* leaderboard */
    var lb = el('div', 'card');
    var lh = el('div', 'card-head');
    lh.appendChild(el('h3', null, 'Model leaderboard — held-out test split'));
    lh.appendChild(el('span', 'card-note', fmtInt(f.yTest.length) + ' transactions · ' + fmtInt(b.yTest.length) + ' companies'));
    lb.appendChild(lh);

    var wrap = el('div', 'table-wrap');
    var t = el('table', 'data');
    var thead = el('thead');
    var tr = el('tr');
    ['Task', 'Model', 'ROC-AUC', 'Precision', 'Recall', 'F1', 'Accuracy', 'Threshold'].forEach(function (h) { tr.appendChild(el('th', null, h)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    [['Fraud detection', f], ['Business failure', b]].forEach(function (task) {
      [['Random Forest', 'rf'], ['XGBoost', 'gbt'], ['Logistic regression', 'lr'], ['RF + XGBoost ensemble', 'ensemble']].forEach(function (m, mi) {
        var e = task[1].evals[m[1]];
        var row = el('tr');
        row.appendChild(el('td', 'dim', mi === 0 ? task[0] : ''));
        var nameTd = el('td', null, m[0]);
        if (m[1] === 'ensemble') nameTd.style.fontWeight = '600';
        row.appendChild(nameTd);
        [e.auc, e.precision, e.recall, e.f1, e.accuracy].forEach(function (v) {
          row.appendChild(el('td', 'n', fmt(v, 3)));
        });
        row.appendChild(el('td', 'n dim', e.threshold.toFixed(3)));
        tb.appendChild(row);
      });
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    lb.appendChild(wrap);

    var gap = f.evals.ensemble.auc - f.evals.lr.auc;
    lb.appendChild(el('div', 'hint', 'The ensemble beats the logistic baseline by ' + (gap * 1000).toFixed(0) +
      ' AUC points on the fraud task. That gap is the part of the risk that lives in interactions between features rather than in any feature on its own — the whole argument for using trees here.'));
    host.appendChild(lb);

    /* ROC + confusion */
    var evalRow = el('div');
    evalRow.style.display = 'grid';
    evalRow.style.gap = '14px';
    evalRow.style.gridTemplateColumns = 'repeat(auto-fit, minmax(300px, 1fr))';

    var rocCard = el('div', 'card');
    var rch = el('div', 'card-head');
    rch.appendChild(el('h3', null, 'ROC — fraud detection'));
    rocCard.appendChild(rch);
    var rocChart = el('div', 'chart');
    rocCard.appendChild(rocChart);
    renderROC(rocChart, [
      { name: 'RF + XGBoost', points: f.curves.ensemble, auc: f.evals.ensemble.auc, colour: 'var(--s1)' },
      { name: 'Random Forest', points: f.curves.rf, auc: f.evals.rf.auc, colour: 'var(--s3)' },
      { name: 'Logistic regression', points: f.curves.lr, auc: f.evals.lr.auc, colour: 'var(--s2)' }
    ]);
    evalRow.appendChild(rocCard);

    var cmCard = el('div', 'card');
    var cmh = el('div', 'card-head');
    cmh.appendChild(el('h3', null, 'Confusion matrix'));
    var sel = el('select');
    sel.id = 'cm-model';
    sel.style.width = 'auto';
    [['ensemble', 'RF + XGBoost'], ['rf', 'Random Forest'], ['gbt', 'XGBoost'], ['lr', 'Logistic regression']].forEach(function (m) {
      var o = el('option', null, m[1]);
      o.value = m[0];
      if (state.method.model === m[0]) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      state.method.model = sel.value;
      state.method.threshold = f.evals[sel.value].threshold;
      renderMethodology();
    });
    cmh.appendChild(sel);
    cmCard.appendChild(cmh);
    var cmBody = el('div');
    cmCard.appendChild(cmBody);
    renderConfusion(cmBody, f);
    evalRow.appendChild(cmCard);
    host.appendChild(evalRow);

    /* feature importance */
    var impCard = el('div', 'card');
    var ih = el('div', 'card-head');
    ih.appendChild(el('h3', null, 'What each model learned to rely on'));
    ih.appendChild(el('span', 'card-note', 'Fraud task'));
    impCard.appendChild(ih);
    var impCols = el('div');
    impCols.style.display = 'grid';
    impCols.style.gap = '18px';
    impCols.style.gridTemplateColumns = 'repeat(auto-fit, minmax(250px, 1fr))';
    [
      ['Random Forest — mean Gini decrease', f.rf.importanceNorm, function (v) { return fmtPct(v, 1); }],
      ['XGBoost — total split gain', f.gbt.importanceNorm, function (v) { return fmtPct(v, 1); }],
      ['Logistic regression — standardised coefficient', f.lr.coefficients(), function (v) { return v.toFixed(2); }]
    ].forEach(function (col) {
      var c = el('div');
      c.appendChild(el('div', 'eyebrow', col[0]));
      var chart = el('div');
      chart.style.marginTop = '8px';
      c.appendChild(chart);
      renderAttributions(chart, col[1].map(function (v, k) {
        return { label: D.TXN_FEATURES[k].label, value: v, hint: D.TXN_FEATURES[k].hint };
      }).sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); }).slice(0, 8),
        { unit: 'Importance', format: col[2] });
      impCols.appendChild(c);
    });
    impCard.appendChild(impCols);
    impCard.appendChild(el('div', 'hint', 'The two tree models agree on which interactions carry the signal and rank them similarly. The logistic coefficients show the same features, but flattened into independent effects — the reason its AUC trails.'));
    host.appendChild(impCard);

    /* methods 01-07 */
    var mCard = el('div', 'card');
    var mList = el('div', 'method-list');
    METHODS.forEach(function (m) {
      var node = el('div', 'method');
      node.appendChild(el('div', 'method-num', m.n));
      var mid = el('div');
      mid.appendChild(el('h3', null, m.title));
      mid.appendChild(el('div', 'method-kind', m.kind));
      var body = el('div', 'method-body');
      m.body.forEach(function (p) {
        var para = el('p');
        para.innerHTML = p;
        body.appendChild(para);
      });
      mid.appendChild(body);
      node.appendChild(mid);
      node.appendChild(methodEvidence(m.n));
      mList.appendChild(node);
    });
    mCard.appendChild(mList);
    host.appendChild(mCard);

    /* retrain */
    var rtCard = el('div', 'card');
    var rth = el('div', 'card-head');
    rth.appendChild(el('h3', null, 'Refit the fraud models'));
    rth.appendChild(el('span', 'card-note', 'Changes everything above'));
    rtCard.appendChild(rth);
    rtCard.appendChild(el('div', 'hint', 'These are live hyperparameters, not a demonstration. Change one and the models are refitted from scratch, the leaderboard and curves recompute, and the run log gains an entry.'));

    var cfg = el('div');
    cfg.style.display = 'grid';
    cfg.style.gap = '12px';
    cfg.style.gridTemplateColumns = 'repeat(auto-fit, minmax(160px, 1fr))';
    cfg.style.marginTop = '12px';
    [
      { id: 'cfg-rf-trees', label: 'Forest trees', min: 10, max: 160, step: 10, value: f.hyper.rf.nTrees },
      { id: 'cfg-rf-depth', label: 'Max tree depth', min: 3, max: 14, step: 1, value: f.hyper.rf.maxDepth },
      { id: 'cfg-gb-rounds', label: 'Boosting rounds', min: 20, max: 300, step: 20, value: f.hyper.gbt.nRounds },
      { id: 'cfg-gb-eta', label: 'Learning rate (eta)', min: 0.02, max: 0.4, step: 0.01, value: f.hyper.gbt.eta }
    ].forEach(function (c) {
      var fd = el('div', 'field');
      var lab = el('label');
      lab.setAttribute('for', c.id);
      lab.appendChild(document.createTextNode(c.label));
      var v = el('span', 'field-unit', String(c.value));
      lab.appendChild(v);
      fd.appendChild(lab);
      var inp = el('input');
      inp.type = 'range';
      inp.id = c.id;
      inp.min = c.min; inp.max = c.max; inp.step = c.step; inp.value = c.value;
      inp.addEventListener('input', function () { v.textContent = inp.value; });
      fd.appendChild(inp);
      cfg.appendChild(fd);
    });
    rtCard.appendChild(cfg);

    var rtBtn = el('button', 'btn btn-primary', 'Refit and re-evaluate');
    rtBtn.type = 'button';
    rtBtn.style.marginTop = '12px';
    rtBtn.addEventListener('click', function () {
      rtBtn.disabled = true;
      clear(rtBtn);
      rtBtn.appendChild(el('span', 'spinner'));
      rtBtn.appendChild(document.createTextNode('Fitting…'));
      setTimeout(function () {
        trainFraud();
        if (state.scan.scored) runScan();
        renderMethodology();
        renderScanControls();
      }, 30);
    });
    rtCard.appendChild(rtBtn);
    host.appendChild(rtCard);

    /* run log */
    var rl = el('div', 'card flush');
    var rlh = el('div', 'card-head');
    rlh.style.padding = '14px 16px 0';
    rlh.appendChild(el('h3', null, 'Run log — system record'));
    var rlExp = el('button', 'btn btn-sm', 'Export JSON');
    rlExp.type = 'button';
    rlExp.addEventListener('click', function () {
      openExport('run_log_' + Date.now() + '.json', JSON.stringify(state.runLog, null, 2), state.runLog.length);
    });
    rlh.appendChild(rlExp);
    rl.appendChild(rlh);

    var rlWrap = el('div', 'table-wrap scroll-y');
    rlWrap.style.marginTop = '12px';
    var rt = el('table', 'data');
    var rthead = el('thead');
    var rtr = el('tr');
    ['Run', 'Time', 'Job', 'Model', 'Dataset', 'Rows', 'Latency', 'Result'].forEach(function (h) { rtr.appendChild(el('th', null, h)); });
    rthead.appendChild(rtr);
    rt.appendChild(rthead);
    var rtb = el('tbody');
    state.runLog.slice().reverse().forEach(function (e) {
      var row = el('tr');
      row.appendChild(el('td', 'mono', e.id));
      row.appendChild(el('td', 'dim', e.ts));
      var jt = el('td');
      jt.appendChild(el('span', 'chip ' + (e.job === 'fit' ? 'chip-neutral' : 'chip-good'), e.job));
      row.appendChild(jt);
      row.appendChild(el('td', null, e.model));
      row.appendChild(el('td', 'dim', e.dataset));
      row.appendChild(el('td', 'n', fmtInt(e.rows)));
      row.appendChild(el('td', 'n', e.ms.toFixed(1) + ' ms'));
      var res = '';
      if (e.metrics) {
        if (e.metrics.auc != null) res = 'AUC ' + fmt(e.metrics.auc, 3) + ' · F1 ' + fmt(e.metrics.f1, 3);
        else if (e.metrics.high != null) res = fmtInt(e.metrics.high) + ' high · ' + fmtInt(e.metrics.medium) + ' medium';
        else if (e.metrics.healthScore != null) res = 'Score ' + e.metrics.healthScore.toFixed(1) + ' · p ' + fmt(e.metrics.failureProb, 3);
        else if (e.metrics.meanScore != null) res = 'Mean ' + fmt(e.metrics.meanScore, 3);
      }
      row.appendChild(el('td', 'dim', res));
      rtb.appendChild(row);
    });
    rt.appendChild(rtb);
    rlWrap.appendChild(rt);
    rl.appendChild(rlWrap);
    var rlNote = el('div', 'hint');
    rlNote.style.padding = '10px 16px';
    rlNote.textContent = state.runLog.length + ' jobs this session. Each entry records the hyperparameters used and the metrics produced; the JSON export carries the full detail.';
    rl.appendChild(rlNote);
    host.appendChild(rl);
  }

  function methodEvidence(n) {
    var box = el('div', 'method-evidence');
    var f = state.fraud, b = state.business;
    var pairs = [];
    var title = 'Live evidence';

    if (n === '01') {
      var rs = f.rf.stats();
      pairs = [
        ['Trees fitted', rs.trees], ['Avg depth', rs.avgDepth.toFixed(1)],
        ['Avg leaves/tree', rs.avgLeaves.toFixed(0)], ['Total nodes', fmtInt(rs.totalNodes)],
        ['Features per split', f.rf.opt.maxFeatures],
        ['Out-of-bag AUC', fmt(f.rf.oobAuc, 3)],
        ['Test AUC', fmt(f.evals.rf.auc, 3)]
      ];
    } else if (n === '02') {
      var gs = f.gbt.stats();
      pairs = [
        ['Boosting rounds', gs.rounds], ['Learning rate', f.hyper.gbt.eta],
        ['Max depth', f.hyper.gbt.maxDepth], ['Lambda / gamma', f.hyper.gbt.lambda + ' / ' + f.hyper.gbt.gamma],
        ['Subsample', f.hyper.gbt.subsample],
        ['Final train loss', fmt(gs.finalLoss, 4)],
        ['Test AUC', fmt(f.evals.gbt.auc, 3)]
      ];
    } else if (n === '03') {
      var top = f.lr.coefficients().map(function (v, k) { return { k: k, v: v }; })
        .sort(function (a, c) { return Math.abs(c.v) - Math.abs(a.v); })[0];
      pairs = [
        ['Features', f.lr.w.length], ['L2 penalty', f.hyper.lr.l2],
        ['Epochs', f.hyper.lr.epochs],
        ['Strongest coefficient', D.TXN_FEATURES[top.k].label],
        ['Its odds ratio', Math.exp(top.v).toFixed(2) + '×'],
        ['Test AUC', fmt(f.evals.lr.auc, 3)],
        ['AUC behind ensemble', (f.evals.ensemble.auc - f.evals.lr.auc).toFixed(3)]
      ];
    } else if (n === '04') {
      var tx = state.text;
      pairs = [
        ['Encoder blocks / heads', '1 / 1'],
        ['Embedding dim', tx ? tx.opt.dim : 12],
        ['Vocabulary', tx ? fmtInt(tx.vocabList.length) : '—'],
        ['Parameters', tx ? fmtInt(tx.nParams) : '—'],
        ['Train / held-out docs', tx ? (tx.nTrain + ' / ' + tx.nTest) : '—'],
        ['Train AUC', tx ? fmt(tx.trainAuc, 3) : '—'],
        ['Held-out AUC', tx && tx.testAuc != null ? fmt(tx.testAuc, 3) : '—']
      ];
    } else if (n === '05') {
      pairs = [
        ['SHAP method', 'Permutation'], ['Permutations/case', 80],
        ['Background sample', 40],
        ['LIME samples', 240], ['LIME neighbourhood', '0.35 SD'],
        ['Bulk method', 'Tree path decomposition'],
        ['Bulk cost per row', '~' + (f.rf.stats().avgDepth * f.rf.trees.length).toFixed(0) + ' comparisons']
      ];
    } else if (n === '06') {
      pairs = [
        ['Train / test split', '70 / 30'],
        ['Test transactions', fmtInt(f.yTest.length)],
        ['Test companies', fmtInt(b.yTest.length)],
        ['Fraud base rate', fmtPct(f.baseRate, 2)],
        ['Failure base rate', fmtPct(b.baseRate, 2)],
        ['Threshold rule', 'max F1'],
        ['Best test AUC', fmt(f.evals.ensemble.auc, 3)]
      ];
    } else {
      var scored = state.scan.scored;
      pairs = [
        ['Jobs this session', state.runLog.length],
        ['Models fitted', state.runLog.filter(function (e) { return e.job === 'fit'; }).length],
        ['Scoring batches', state.runLog.filter(function (e) { return e.job === 'score'; }).length],
        ['Rows scored', fmtInt(state.runLog.filter(function (e) { return e.job === 'score'; }).reduce(function (a, e) { return a + e.rows; }, 0))],
        ['Queue built from', scored ? fmtInt(scored.rows.length) + ' rows' : 'no file yet'],
        ['Total fit time', state.runLog.filter(function (e) { return e.job === 'fit'; }).reduce(function (a, e) { return a + e.ms; }, 0).toFixed(0) + ' ms'],
        ['Audit trail', 'Exports as JSON']
      ];
    }

    box.appendChild(el('span', 'eyebrow', title));
    var dl = el('dl');
    dl.style.margin = '0';
    pairs.forEach(function (p) {
      var row = el('div', 'kv');
      row.appendChild(el('dt', null, p[0]));
      row.appendChild(el('dd', null, String(p[1])));
      dl.appendChild(row);
    });
    box.appendChild(dl);
    return box;
  }

  /* The slider is built once and kept; only the matrix and the metric tiles
     are redrawn as it moves. Rebuilding the input mid-drag would drop the
     pointer capture and the slider would stick after one pixel. */
  function renderConfusion(host, suite) {
    clear(host);
    var readout = el('div');
    host.appendChild(readout);

    var fd = el('div', 'field');
    fd.style.marginTop = '12px';
    var lab = el('label');
    lab.setAttribute('for', 'cm-thr');
    lab.appendChild(document.createTextNode('Decision threshold'));
    var lv = el('span', 'field-unit', '');
    lab.appendChild(lv);
    fd.appendChild(lab);
    var sl = el('input');
    sl.type = 'range';
    sl.id = 'cm-thr';
    sl.min = 0.01; sl.max = 0.95; sl.step = 0.005;
    fd.appendChild(sl);
    host.appendChild(fd);

    var note = el('div', 'hint');
    host.appendChild(note);

    function draw(thr) {
      lv.textContent = thr.toFixed(3);
      note.textContent = 'Raising the threshold cuts wasted reviews and lets more fraud through. ' +
        'The F1-optimal point for this model is ' + suite.evals[state.method.model].threshold.toFixed(3) + '.';
      drawMatrix(readout, suite, thr);
    }

    sl.addEventListener('input', function () {
      state.method.threshold = +sl.value;
      draw(+sl.value);
    });

    var start = state.method.threshold == null ? suite.evals[state.method.model].threshold : state.method.threshold;
    sl.value = start;
    draw(start);
  }

  function drawMatrix(host, suite, thr) {
    clear(host);
    var key = state.method.model;
    var e = ML.evaluate(suite.yTest, suite.scores[key], thr);
    var c = e.confusion;

    var grid = el('div', 'cm');
    grid.appendChild(el('div', 'cm-axis', ''));
    grid.appendChild(el('div', 'cm-axis', 'Predicted fraud'));
    grid.appendChild(el('div', 'cm-axis', 'Predicted clean'));

    grid.appendChild(el('div', 'cm-axis', 'Actual fraud'));
    var tp = el('div', 'cm-cell cm-hit');
    tp.appendChild(el('div', 'k', 'True positive'));
    tp.appendChild(el('div', 'v', fmtInt(c.tp)));
    grid.appendChild(tp);
    var fn = el('div', 'cm-cell cm-miss');
    fn.appendChild(el('div', 'k', 'False negative — missed'));
    fn.appendChild(el('div', 'v', fmtInt(c.fn)));
    grid.appendChild(fn);

    grid.appendChild(el('div', 'cm-axis', 'Actual clean'));
    var fp = el('div', 'cm-cell cm-miss');
    fp.appendChild(el('div', 'k', 'False positive — wasted review'));
    fp.appendChild(el('div', 'v', fmtInt(c.fp)));
    grid.appendChild(fp);
    var tn = el('div', 'cm-cell cm-hit');
    tn.appendChild(el('div', 'k', 'True negative'));
    tn.appendChild(el('div', 'v', fmtInt(c.tn)));
    grid.appendChild(tn);

    host.appendChild(grid);

    var stats = el('div', 'stat-row');
    stats.style.marginTop = '12px';
    [['Precision', fmt(e.precision, 3)], ['Recall', fmt(e.recall, 3)],
     ['F1', fmt(e.f1, 3)], ['Accuracy', fmt(e.accuracy, 3)],
     ['FPR', fmt(e.falsePositiveRate, 4)]].forEach(function (s) {
      var n = el('div', 'stat');
      n.appendChild(el('div', 'stat-label', s[0]));
      n.appendChild(el('div', 'stat-value sm', s[1]));
      stats.appendChild(n);
    });
    host.appendChild(stats);
  }

  /* ================================ modals =============================== */

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

  /* ============================== chrome ================================= */

  function setTab(tab) {
    state.tab = tab;
    ['scanner', 'health', 'method'].forEach(function (t) {
      var btn = $('tab-' + t), panel = $('panel-' + t);
      if (btn) btn.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      if (panel) panel.hidden = t !== tab;
    });
    if (tab === 'method') renderMethodology();
    if (tab === 'health' && !state.health.result && state.health.mode === 'manual') computeHealth();
    window.scrollTo(0, 0);
  }

  /* ================================= boot ================================ */

  function setStatus(text, busy) {
    var n = $('boot-status');
    if (!n) return;
    clear(n);
    if (busy) n.appendChild(el('span', 'spinner'));
    n.appendChild(document.createTextNode(text));
  }

  function boot() {
    ['scanner', 'health', 'method'].forEach(function (t) {
      var b = $('tab-' + t);
      if (b) b.addEventListener('click', function () { setTab(t); });
    });

    setStatus('Fitting fraud models…', true);
    renderScanControls();
    renderScanResults();

    setTimeout(function () {
      trainFraud();
      renderScanControls();
      loadSampleTransactions();
      setStatus('Fitting failure and narrative models…', true);

      setTimeout(function () {
        trainBusiness();
        trainText();
        renderHealthControls();
        computeHealth();
        renderMethodology();
        var totalFit = state.runLog.filter(function (e) { return e.job === 'fit'; }).reduce(function (a, e) { return a + e.ms; }, 0);
        setStatus(state.runLog.length + ' jobs · ' + totalFit.toFixed(0) + ' ms total fit', false);
      }, 40);
    }, 40);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
