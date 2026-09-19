/* ============================================================================
   landing.js - the public "Free Tools" page (index.html, the site root)

   Not part of the customer application and not gated by sign-in. Both checks
   here run entirely on the deterministic, non-ML parts of the platform
   (buildTxnFeatures's derived ratios and the four-pillar health score) -
   no model training, no network call, so a first-time visitor gets an answer
   immediately. The full ensemble, SHAP/LIME explainability and portfolio
   scoring stay behind sign-in, which is what the "Create free account"
   banner on this page points at.
   ========================================================================== */
(function () {
  'use strict';

  var UI = window.BRI.UI, D = window.BRI.Data;
  var $ = UI.$, el = UI.el, clear = UI.clear, fmtMoney = UI.fmtMoney, fmtPct = UI.fmtPct;

  /* ============================== navigation ============================= */

  var TABS = ['tools', 'method', 'about'];

  function setTab(name) {
    TABS.forEach(function (t) {
      $('pub-panel-' + t).hidden = t !== name;
      $('pub-tab-' + t).setAttribute('aria-selected', t === name ? 'true' : 'false');
    });
  }

  TABS.forEach(function (t) {
    $('pub-tab-' + t).addEventListener('click', function () { setTab(t); });
  });

  /* ========================= basic fraud risk check ======================= */

  var CHANNEL_OPTIONS = ['Card present', 'Card not present', 'ATM', 'Wire transfer', 'Wallet'];

  function riskBand(score) {
    if (score >= 70) return { label: 'Critical', chip: 'chip-critical' };
    if (score >= 45) return { label: 'Elevated', chip: 'chip-serious' };
    if (score >= 22) return { label: 'Watch', chip: 'chip-warning' };
    return { label: 'Stable', chip: 'chip-good' };
  }

  function renderFraudControls() {
    var host = $('fraud-controls');
    clear(host);

    var amountF = el('div', 'field');
    var amountL = el('label');
    amountL.setAttribute('for', 'bf-amount');
    amountL.appendChild(document.createTextNode('Amount'));
    amountL.appendChild(el('span', 'field-unit', 'USD'));
    amountF.appendChild(amountL);
    var amount = el('input');
    amount.type = 'number'; amount.id = 'bf-amount'; amount.placeholder = 'e.g. 1,000'; amount.min = 0;
    amountF.appendChild(amount);
    host.appendChild(amountF);

    var timeF = el('div', 'field');
    var timeL = el('label');
    timeL.setAttribute('for', 'bf-time');
    timeL.appendChild(document.createTextNode('Time'));
    timeF.appendChild(timeL);
    var time = el('input');
    time.type = 'text'; time.id = 'bf-time'; time.placeholder = 'e.g. 2024-01-15 14:30';
    timeF.appendChild(time);
    host.appendChild(timeF);

    var typeF = el('div', 'field');
    var typeL = el('label');
    typeL.setAttribute('for', 'bf-type');
    typeL.appendChild(document.createTextNode('Type'));
    typeF.appendChild(typeL);
    var type = el('select');
    type.id = 'bf-type';
    CHANNEL_OPTIONS.forEach(function (c) { var o = el('option', null, c); o.value = c; type.appendChild(o); });
    typeF.appendChild(type);
    host.appendChild(typeF);

    var locF = el('div', 'field');
    var locL = el('label');
    locL.setAttribute('for', 'bf-location');
    locL.appendChild(document.createTextNode('Location'));
    locF.appendChild(locL);
    var loc = el('input');
    loc.type = 'text'; loc.id = 'bf-location'; loc.placeholder = 'e.g. New York, US';
    locF.appendChild(loc);
    host.appendChild(locF);

    var hint = el('div', 'hint', 'Assumes a home country of US. A single transaction has no history to compare against, so this is a lighter check than the signed-in scanner’s full velocity analysis.');
    host.appendChild(hint);

    var run = el('button', 'btn btn-primary btn-block', 'Run Fraud Risk Check');
    run.type = 'button';
    run.addEventListener('click', runFraudCheck);
    host.appendChild(run);
  }

  /* Single-row adapter around buildTxnFeatures: batch-relative signals
     (velocity, 30-day average) have no meaning for one ad-hoc transaction, so
     they are fed neutral values (this transaction is treated as its own
     30-day average, and as the account's second transaction in 24h) rather
     than invented history. */
  function runFraudCheck() {
    var amount = D.num($('bf-amount').value, null);
    var host = $('fraud-results');
    clear(host);
    if (amount == null || amount <= 0) {
      host.appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Enter an amount to run the check.'));
      return;
    }

    var timeVal = $('bf-time').value;
    var type = $('bf-type').value;
    var location = $('bf-location').value.trim();

    var row = {
      amount: amount,
      timestamp: timeVal || null,
      channel: type,
      country: location || null,
      home_country: 'US',
      merchant_age_days: 365,
      device_new: 0,
      txn_count_24h: 2,
      avg_amount_30d: amount,
      account_age_days: 400,
      merchant_category: null
    };
    var mapping = {
      amount: 'amount', timestamp: 'timestamp', channel: 'channel',
      country: 'country', home_country: 'home_country'
    };
    var built = D.buildTxnFeatures([row], mapping);
    var f = built.X[0];
    // f: [amount_log, amount_ratio, night_risk, is_cnp, cross_border,
    //     merchant_new, velocity, device_new, account_age, mcc_risk, weekend, round_amount]
    var score = 0;
    score += f[2] * 22;               // off-hours timing
    score += f[3] * 20;                // card-not-present
    score += f[4] * 28;                // cross-border
    score += Math.min(amount / 10000, 1) * 20; // large ticket size
    score += f[10] * 5;                // weekend
    score = Math.max(0, Math.min(100, Math.round(score)));

    var band = riskBand(score);

    var card = el('div', 'card');
    var head = el('div', 'card-head');
    head.appendChild(el('h3', null, 'Fraud risk result'));
    head.appendChild(el('span', 'chip ' + band.chip, band.label + ' risk'));
    card.appendChild(head);

    var bl = el('div', 'barline');
    var bh = el('div', 'barline-head');
    bh.appendChild(el('span', null, 'Risk score'));
    bh.appendChild(el('span', 'v', score + ' / 100'));
    bl.appendChild(bh);
    var track = el('div', 'bartrack');
    var fill = el('div', 'barfill');
    fill.style.width = score + '%';
    fill.style.background = score >= 70 ? 'var(--critical)' : (score >= 45 ? 'var(--serious)' : (score >= 22 ? 'var(--warning)' : 'var(--good)'));
    track.appendChild(fill);
    bl.appendChild(track);
    card.appendChild(bl);

    var reasons = [];
    if (f[4]) reasons.push('the transaction crosses borders from the assumed home country (US)');
    if (f[3]) reasons.push('the channel is card-not-present');
    if (f[2] >= 0.5) reasons.push('it falls in an off-hours window');
    if (amount >= 10000) reasons.push('the amount is unusually large');
    var note = el('p', 'hint');
    note.style.marginTop = '8px';
    note.textContent = reasons.length
      ? 'Driven mainly by: ' + reasons.join(', ') + '.'
      : 'No elevated signals found in this basic check.';
    card.appendChild(note);

    host.appendChild(card);
  }

  /* ======================= basic business health check ==================== */

  var BHEALTH_FIELDS = [
    { key: 'annual_revenue', label: 'Annual revenue', placeholder: 'e.g. 4200000', step: 10000 },
    { key: 'net_profit', label: 'Net profit', placeholder: 'e.g. 268000', step: 5000 },
    { key: 'total_assets', label: 'Total assets', placeholder: 'e.g. 3150000', step: 10000 },
    { key: 'total_liabilities', label: 'Total liabilities', placeholder: 'e.g. 1980000', step: 10000 }
  ];

  function renderBHealthControls() {
    var host = $('bhealth-controls');
    clear(host);

    BHEALTH_FIELDS.forEach(function (m) {
      var f = el('div', 'field');
      var lab = el('label');
      lab.setAttribute('for', 'bh-' + m.key);
      lab.appendChild(document.createTextNode(m.label));
      lab.appendChild(el('span', 'field-unit', 'USD'));
      f.appendChild(lab);
      var inp = el('input');
      inp.type = 'number'; inp.id = 'bh-' + m.key; inp.placeholder = m.placeholder; inp.step = m.step;
      f.appendChild(inp);
      host.appendChild(f);
    });

    var cashF = el('div', 'field');
    var cashL = el('label');
    cashL.setAttribute('for', 'bh-cash');
    cashL.appendChild(document.createTextNode('Cash reserve'));
    var cashV = el('span', 'field-unit', '3.0 months');
    cashL.appendChild(cashV);
    cashF.appendChild(cashL);
    var cash = el('input');
    cash.type = 'range'; cash.id = 'bh-cash'; cash.min = 0; cash.max = 18; cash.step = 0.1; cash.value = 3;
    cash.addEventListener('input', function () { cashV.textContent = (+cash.value).toFixed(1) + ' months'; });
    cashF.appendChild(cash);
    host.appendChild(cashF);

    var run = el('button', 'btn btn-primary btn-block', 'Run Business Health Check');
    run.type = 'button';
    run.addEventListener('click', runBHealthCheck);
    host.appendChild(run);
  }

  function runBHealthCheck() {
    var host = $('bhealth-results');
    clear(host);

    var f = {};
    var complete = BHEALTH_FIELDS.every(function (m) {
      var node = $('bh-' + m.key);
      f[m.key] = D.num(node.value, 0);
      return node.value.trim() !== '';
    });
    f.cash_reserve_months = +$('bh-cash').value;

    if (!complete) {
      host.appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Enter all five figures to calculate a score.'));
      return;
    }

    var built = D.financialsToFeatures(f);
    var hs = D.healthScore(built.ratios);
    var risk = hs.total >= 60 ? { label: 'Stable', chip: 'chip-good' }
      : hs.total >= 40 ? { label: 'Watch', chip: 'chip-warning' }
      : { label: 'At risk', chip: 'chip-critical' };

    var card = el('div', 'card');
    var head = el('div', 'card-head');
    head.appendChild(el('h3', null, 'Business health score'));
    head.appendChild(el('span', 'chip ' + risk.chip, hs.grade.label));
    card.appendChild(head);

    var scoreLine = el('div', 'barline');
    var sh = el('div', 'barline-head');
    sh.appendChild(el('span', null, 'Overall score'));
    sh.appendChild(el('span', 'v', hs.total.toFixed(1) + ' / 100'));
    scoreLine.appendChild(sh);
    var strack = el('div', 'bartrack');
    var sfill = el('div', 'barfill');
    sfill.style.width = hs.total + '%';
    sfill.style.background = hs.total >= 75 ? 'var(--good)' : (hs.total >= 40 ? 'var(--warning)' : 'var(--critical)');
    strack.appendChild(sfill);
    scoreLine.appendChild(strack);
    card.appendChild(scoreLine);

    var pillars = el('div', 'stack');
    pillars.style.marginTop = '10px';
    hs.pillars.forEach(function (p) {
      var bl = el('div', 'barline');
      var bh = el('div', 'barline-head');
      bh.appendChild(el('span', null, p.label));
      bh.appendChild(el('span', 'v', p.score.toFixed(1) + ' / 25'));
      bl.appendChild(bh);
      var track = el('div', 'bartrack');
      var fill = el('div', 'barfill');
      fill.style.width = (p.score / 25 * 100) + '%';
      fill.style.background = p.score >= 18 ? 'var(--good)' : (p.score >= 11 ? 'var(--s1)' : (p.score >= 6 ? 'var(--warning)' : 'var(--critical)'));
      track.appendChild(fill);
      bl.appendChild(track);
      bl.appendChild(el('div', 'hint', p.detail));
      pillars.appendChild(bl);
    });
    card.appendChild(pillars);

    var note = el('p', 'hint');
    note.style.marginTop = '10px';
    note.textContent = 'A basic score from four figures plus cash reserve. Sign in for the full nine-field model, failure-probability estimate, and SHAP/LIME driver breakdown.';
    card.appendChild(note);

    host.appendChild(card);
  }

  /* =================================== boot =============================== */

  UI.initTheme();
  renderFraudControls();
  renderBHealthControls();
  $('fraud-results').appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Run the check to see a result.'));
  $('bhealth-results').appendChild(el('div', 'card')).appendChild(el('div', 'empty', 'Run the check to see a result.'));
})();
