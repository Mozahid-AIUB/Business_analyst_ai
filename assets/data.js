/* ============================================================================
   data.js - BRI.Data
   Synthetic data generation, CSV parsing, flexible column mapping and the
   feature engineering that feeds the models in ml.js.

   The generators below are documented data-generating processes with genuine
   non-linear interactions and noise, so the tree ensembles have real structure
   to learn and a linear baseline has real structure to miss.
   ========================================================================== */
(function (global) {
  'use strict';

  var ML = global.BRI.ML;
  var mulberry32 = ML.mulberry32;
  var gauss = ML.gauss;
  var sigmoid = ML.sigmoid;
  var clamp = ML.clamp;

  /* ============================== TRANSACTIONS ============================ */

  var CHANNELS = ['card_present', 'card_not_present', 'atm', 'wire_transfer', 'wallet'];
  var MCC = [
    { name: 'grocery', risk: 0.05 }, { name: 'fuel', risk: 0.18 },
    { name: 'restaurant', risk: 0.08 }, { name: 'electronics', risk: 0.52 },
    { name: 'gift_cards', risk: 0.88 }, { name: 'crypto_exchange', risk: 0.92 },
    { name: 'travel', risk: 0.44 }, { name: 'pharmacy', risk: 0.06 },
    { name: 'money_transfer', risk: 0.76 }, { name: 'apparel', risk: 0.22 },
    { name: 'telecom_topup', risk: 0.62 }, { name: 'utilities', risk: 0.04 }
  ];
  var COUNTRIES = ['BD', 'US', 'GB', 'AE', 'SG', 'MY', 'IN', 'NG', 'RU', 'DE'];
  var MERCHANT_STEMS = ['Nexa', 'Orbit', 'Vireo', 'Halcyon', 'Corvid', 'Mistral', 'Aster',
    'Pallas', 'Quarry', 'Larkspur', 'Meridian', 'Tindal', 'Verdant', 'Hollow', 'Kestrel'];
  var MERCHANT_TAILS = ['Retail', 'Digital', 'Trading', 'Mart', 'Supply', 'Labs', 'Group', 'Exchange'];

  var MEMO_CLEAN = ['recurring subscription renewal', 'in store purchase', 'monthly utility bill',
    'payroll credit', 'grocery basket', 'fuel top up', 'regular vendor payment'];
  var MEMO_DIRTY = ['card verification test', 'urgent transfer request', 'gift card bulk order',
    'refund reversal retry', 'new payee first transfer', 'account credential update then purchase'];

  /* Fraud is generated from four named archetypes, each of which is a
     CONJUNCTION of conditions - none of the component signals is dangerous on
     its own, and two of them are non-monotone (a card-testing transaction is
     suspiciously SMALL; a bust-out happens in a window of account age, not
     above a cut-off). Main effects are deliberately kept small.

     That is the whole point of the design: a logistic model sees only the
     main effects and therefore cannot price these patterns, while a tree
     represents each archetype as a handful of nested splits. The AUC gap the
     evaluation reports is earned by that structure, not asserted. */
  function generateTransactions(n, seed) {
    var rnd = mulberry32(seed || 2024);
    var rows = [];
    var now = Date.UTC(2026, 8, 16, 9, 0, 0);

    for (var i = 0; i < n; i++) {
      var accountAge = Math.round(Math.exp(1.6 + rnd() * 5.6));          // 5 .. 1300 days
      var homeCountry = COUNTRIES[Math.floor(rnd() * 3)];
      var country = rnd() < 0.76 ? homeCountry : COUNTRIES[Math.floor(rnd() * COUNTRIES.length)];
      var channel = CHANNELS[Math.floor(Math.pow(rnd(), 1.15) * CHANNELS.length)];
      var mcc = MCC[Math.floor(rnd() * MCC.length)];
      var baseline = Math.exp(3.0 + gauss(rnd) * 0.8);                    // typical spend
      var avg30 = Math.max(5, baseline * (0.85 + rnd() * 0.35));

      /* Amount is a three-part mixture: ordinary spend, an occasional large
         ticket, and a small tail of micro-transactions. That last mode is
         what makes risk non-monotone in amount. */
      var draw = rnd(), amount;
      if (draw < 0.09) amount = 0.4 + rnd() * 3.6;                        // micro
      else if (draw < 0.22) amount = baseline * Math.exp(1.1 + rnd() * 2.0); // large ticket
      else amount = Math.max(1.5, baseline * (0.55 + rnd() * 1.0));

      var hour = Math.floor(Math.pow(rnd(), 0.75) * 24);
      var ts = now - Math.floor(rnd() * 30 * 86400000);
      ts = ts - (ts % 86400000) + hour * 3600000 + Math.floor(rnd() * 3600000);
      var merchantAge = Math.round(Math.exp(rnd() * 7.4));                // 1 .. 1600 days
      var deviceNew = rnd() < 0.22 ? 1 : 0;
      var velocity = Math.floor(Math.pow(rnd(), 2.0) * 15) + 1;
      var merchant = MERCHANT_STEMS[Math.floor(rnd() * MERCHANT_STEMS.length)] + ' ' +
                     MERCHANT_TAILS[Math.floor(rnd() * MERCHANT_TAILS.length)];

      var ratio = amount / (avg30 + 1);
      var crossBorder = country !== homeCountry ? 1 : 0;
      var cnp = (channel === 'card_not_present' || channel === 'wallet') ? 1 : 0;
      var nightness = (hour <= 5 || hour >= 23) ? 1 : (hour <= 7 || hour >= 21 ? 0.5 : 0);

      /* --- the four archetypes ------------------------------------------ */
      /* Card testing: a stolen number is probed with trivial amounts, many
         times, through a remote channel. Non-monotone in amount. */
      var cardTesting = (ratio < 0.14 && velocity >= 5 && cnp) ? 1 : 0;
      /* Account takeover: new device, foreign merchant, spend well above the
         account's own norm. */
      var takeover = (deviceNew && crossBorder && ratio > 2.2) ? 1 : 0;
      /* Bust-out: an account seasoned just long enough to earn a limit, then
         drained through merchants that barely exist. Non-monotone in tenure. */
      var bustOut = (accountAge > 50 && accountAge < 220 && ratio > 2.0 && merchantAge < 70) ? 1 : 0;
      /* Mule transfer: large cross-border push payment. */
      var mule = (channel === 'wire_transfer' && crossBorder && amount > 900) ? 1 : 0;
      /* Category risk only bites when the amount is also unusual. */
      var mccSpike = mcc.risk * Math.min(ratio, 6) / 6;

      var logit = -4.30
        + 3.30 * cardTesting
        + 3.05 * takeover
        + 2.85 * bustOut
        + 2.45 * mule
        + 1.90 * mccSpike
        + 1.05 * nightness * (cnp ? 1 : 0.15)
        + 0.30 * cnp
        + 0.25 * crossBorder
        + 0.20 * deviceNew
        - 0.45 * (accountAge > 900 ? 1 : 0)
        + gauss(rnd) * 0.30;

      var isFraud = rnd() < sigmoid(logit) ? 1 : 0;
      var memo = isFraud && rnd() < 0.55
        ? MEMO_DIRTY[Math.floor(rnd() * MEMO_DIRTY.length)]
        : MEMO_CLEAN[Math.floor(rnd() * MEMO_CLEAN.length)];

      rows.push({
        txn_id: 'TX-' + String(100000 + i),
        timestamp: new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
        account_id: 'AC-' + String(4000 + Math.floor(rnd() * 900)),
        amount: Math.round(amount * 100) / 100,
        currency: 'USD',
        channel: channel,
        merchant: merchant,
        merchant_category: mcc.name,
        merchant_age_days: merchantAge,
        country: country,
        home_country: homeCountry,
        device_new: deviceNew,
        txn_count_24h: velocity,
        avg_amount_30d: Math.round(avg30 * 100) / 100,
        account_age_days: accountAge,
        memo: memo,
        is_fraud: isFraud
      });
    }
    return rows;
  }

  /* Field catalogue for the transaction mapper. `aliases` drive auto-detection
     of an uploaded file's headers; only `amount` is genuinely required. */
  var TXN_FIELDS = [
    { key: 'amount', label: 'Transaction amount', required: true, type: 'number',
      aliases: ['amount', 'amt', 'transaction_amount', 'txn_amount', 'trans_amount', 'value', 'total', 'debit', 'transactionamount'] },
    { key: 'timestamp', label: 'Timestamp', type: 'date',
      aliases: ['timestamp', 'time', 'date', 'datetime', 'txn_date', 'transaction_date', 'created_at', 'posted'] },
    { key: 'txn_id', label: 'Transaction ID', type: 'text',
      aliases: ['txn_id', 'transaction_id', 'id', 'reference', 'ref', 'trace', 'trans_id'] },
    { key: 'account_id', label: 'Account / customer ID', type: 'text',
      aliases: ['account_id', 'account', 'customer_id', 'customer', 'card_id', 'user_id', 'client_id'] },
    { key: 'channel', label: 'Channel', type: 'text',
      aliases: ['channel', 'entry_mode', 'pos_entry', 'txn_type', 'transaction_type', 'type', 'method'] },
    { key: 'merchant', label: 'Merchant name', type: 'text',
      aliases: ['merchant', 'merchant_name', 'payee', 'beneficiary', 'vendor', 'counterparty'] },
    { key: 'merchant_category', label: 'Merchant category', type: 'text',
      aliases: ['merchant_category', 'mcc', 'category', 'merchant_type', 'sector', 'industry'] },
    { key: 'merchant_age_days', label: 'Merchant age (days)', type: 'number',
      aliases: ['merchant_age_days', 'merchant_age', 'payee_age', 'vendor_age'] },
    { key: 'country', label: 'Transaction country', type: 'text',
      aliases: ['country', 'txn_country', 'location', 'merchant_country', 'geo', 'region'] },
    { key: 'home_country', label: 'Account home country', type: 'text',
      aliases: ['home_country', 'account_country', 'issuer_country', 'residence', 'billing_country'] },
    { key: 'device_new', label: 'New device flag', type: 'number',
      aliases: ['device_new', 'new_device', 'device_change', 'unrecognised_device', 'is_new_device'] },
    { key: 'txn_count_24h', label: 'Transactions in 24h', type: 'number',
      aliases: ['txn_count_24h', 'velocity', 'count_24h', 'daily_count', 'trans_count', 'freq'] },
    { key: 'avg_amount_30d', label: 'Average amount (30d)', type: 'number',
      aliases: ['avg_amount_30d', 'avg_amount', 'mean_amount', 'average_txn', 'baseline_amount'] },
    { key: 'account_age_days', label: 'Account age (days)', type: 'number',
      aliases: ['account_age_days', 'account_age', 'tenure', 'customer_age_days', 'days_since_open'] },
    { key: 'memo', label: 'Memo / description', type: 'text',
      aliases: ['memo', 'description', 'narrative', 'note', 'details', 'remarks', 'particulars'] },
    { key: 'is_fraud', label: 'Known fraud label (optional)', type: 'number',
      aliases: ['is_fraud', 'fraud', 'label', 'target', 'class', 'is_flagged', 'chargeback', 'confirmed_fraud'] }
  ];

  var TXN_FEATURES = [
    { key: 'amount_log',    label: 'Amount (log)',            hint: 'Log-scaled ticket size' },
    { key: 'amount_ratio',  label: 'Amount vs account norm',  hint: 'Amount divided by the account 30-day average' },
    { key: 'night_risk',    label: 'Off-hours timing',        hint: '1 at 23:00-05:00, 0.5 in shoulder hours' },
    { key: 'is_cnp',        label: 'Card-not-present',        hint: 'Remote channel with no physical card' },
    { key: 'cross_border',  label: 'Cross-border',            hint: 'Transaction country differs from home country' },
    { key: 'merchant_new',  label: 'Merchant newness',        hint: 'Decays to 0 as the merchant ages past 1 year' },
    { key: 'velocity',      label: '24h velocity',            hint: 'Transactions on the account in 24 hours' },
    { key: 'device_new',    label: 'New device',              hint: 'Device not previously seen on the account' },
    { key: 'account_age',   label: 'Account tenure (log)',    hint: 'Log days since the account opened' },
    { key: 'mcc_risk',      label: 'Category risk',           hint: 'Fraud propensity of the merchant category' },
    { key: 'weekend',       label: 'Weekend',                 hint: 'Saturday or Sunday' },
    { key: 'round_amount',  label: 'Round-number amount',     hint: 'Amount is an exact multiple of 100' }
  ];

  var MCC_RISK_LOOKUP = {};
  MCC.forEach(function (m) { MCC_RISK_LOOKUP[m.name] = m.risk; });

  function mccRiskOf(cat) {
    if (cat == null) return 0.3;
    var c = String(cat).toLowerCase().replace(/[^a-z]/g, '_');
    if (MCC_RISK_LOOKUP[c] != null) return MCC_RISK_LOOKUP[c];
    var keys = Object.keys(MCC_RISK_LOOKUP);
    for (var i = 0; i < keys.length; i++) {
      if (c.indexOf(keys[i]) >= 0 || keys[i].indexOf(c) >= 0) return MCC_RISK_LOOKUP[keys[i]];
    }
    if (/crypto|gift|transfer|wire|topup|top_up/.test(c)) return 0.85;
    if (/electronic|travel|jewel|luxury/.test(c)) return 0.5;
    if (/grocer|utilit|pharma|food/.test(c)) return 0.06;
    return 0.3;
  }

  function truthy(v) {
    if (v == null || v === '') return 0;
    var s = String(v).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'y' || s === 'yes' || s === 't') return 1;
    var n = parseFloat(s);
    return (!isNaN(n) && n > 0) ? 1 : 0;
  }

  function num(v, fallback) {
    if (v == null || v === '') return fallback;
    var n = parseFloat(String(v).replace(/[^0-9eE+.\-]/g, ''));
    return isNaN(n) ? fallback : n;
  }

  function parseDate(v) {
    if (!v) return null;
    var d = new Date(v);
    if (!isNaN(d.getTime())) return d;
    var m = String(v).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      d = new Date(parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  }

  /* Build the model matrix from mapped rows. Anything the upload does not
     carry is imputed from what the file does contain (per-account medians
     first, then a file-wide fallback), and the imputed fields are reported
     back so the UI can say how complete the scoring inputs were. */
  function buildTxnFeatures(rows, mapping) {
    var get = function (row, key) {
      var col = mapping[key];
      return col ? row[col] : undefined;
    };

    var amounts = [];
    rows.forEach(function (r) {
      var a = num(get(r, 'amount'), null);
      if (a != null) amounts.push(Math.abs(a));
    });
    amounts.sort(function (a, b) { return a - b; });
    var medianAmount = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 100;

    /* Per-account baseline: when the file has no 30-day average we derive one
       from that account's own history inside the upload. */
    var perAccount = {};
    if (mapping.account_id) {
      rows.forEach(function (r) {
        var acc = String(get(r, 'account_id') || '');
        var a = Math.abs(num(get(r, 'amount'), 0));
        (perAccount[acc] = perAccount[acc] || []).push(a);
      });
      Object.keys(perAccount).forEach(function (k) {
        var v = perAccount[k].slice().sort(function (a, b) { return a - b; });
        perAccount[k] = v[Math.floor(v.length / 2)] || medianAmount;
      });
    }

    var homeMode = null;
    if (mapping.country && !mapping.home_country) {
      var tally = {};
      rows.forEach(function (r) {
        var c = String(get(r, 'country') || '');
        if (c) tally[c] = (tally[c] || 0) + 1;
      });
      homeMode = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0] || null;
    }

    var imputed = [];
    ['timestamp', 'channel', 'country', 'merchant_age_days', 'device_new',
     'txn_count_24h', 'avg_amount_30d', 'account_age_days', 'merchant_category'].forEach(function (k) {
      if (!mapping[k]) imputed.push(k);
    });

    var X = [], meta = [];
    rows.forEach(function (r) {
      var amount = Math.abs(num(get(r, 'amount'), medianAmount));
      var acc = mapping.account_id ? String(get(r, 'account_id') || '') : null;
      var avg30 = num(get(r, 'avg_amount_30d'), null);
      if (avg30 == null) avg30 = (acc && perAccount[acc]) ? perAccount[acc] : medianAmount;
      avg30 = Math.max(1, avg30);

      var d = parseDate(get(r, 'timestamp'));
      var hour = d ? d.getHours() : 13;
      var nightness = (hour <= 5 || hour >= 23) ? 1 : ((hour <= 7 || hour >= 21) ? 0.5 : 0);
      var weekend = d ? ((d.getDay() === 0 || d.getDay() === 6) ? 1 : 0) : 0;

      var chan = String(get(r, 'channel') || '').toLowerCase();
      var cnp = /not_present|not present|cnp|online|ecom|e-com|wallet|remote|internet|web|mobile/.test(chan) ? 1 : 0;

      var country = String(get(r, 'country') || '');
      var home = mapping.home_country ? String(get(r, 'home_country') || '') : homeMode;
      var crossBorder = (country && home && country !== home) ? 1 : 0;

      var mAge = num(get(r, 'merchant_age_days'), null);
      var merchantNew = mAge == null ? 0.25 : clamp(1 - mAge / 365, 0, 1);

      var velocity = num(get(r, 'txn_count_24h'), 2);
      var deviceNew = mapping.device_new ? truthy(get(r, 'device_new')) : 0;
      var accAge = num(get(r, 'account_age_days'), 400);
      var mccRisk = mapping.merchant_category ? mccRiskOf(get(r, 'merchant_category')) : 0.3;

      X.push([
        Math.log1p(amount),
        clamp(amount / avg30, 0, 40),
        nightness,
        cnp,
        crossBorder,
        merchantNew,
        clamp(velocity, 0, 40),
        deviceNew,
        Math.log1p(Math.max(0, accAge)),
        mccRisk,
        weekend,
        (amount > 0 && amount % 100 === 0) ? 1 : 0
      ]);

      meta.push({
        amount: amount,
        avg30: avg30,
        txn_id: mapping.txn_id ? get(r, 'txn_id') : null,
        account_id: acc,
        timestamp: mapping.timestamp ? get(r, 'timestamp') : null,
        merchant: mapping.merchant ? get(r, 'merchant') : null,
        channel: mapping.channel ? get(r, 'channel') : null,
        country: country || null,
        memo: mapping.memo ? get(r, 'memo') : null,
        label: mapping.is_fraud ? truthy(get(r, 'is_fraud')) : null
      });
    });

    return { X: X, meta: meta, imputed: imputed, medianAmount: medianAmount };
  }

  /* ============================ BUSINESS FINANCIALS ======================= */

  var SECTORS = ['Manufacturing', 'Retail', 'Technology', 'Logistics', 'Construction',
    'Healthcare', 'Hospitality', 'Agriculture', 'Professional services'];

  var COMPANY_A = ['Meridian', 'Kestrel', 'Anvil', 'Tamarind', 'Northgate', 'Solstice',
    'Ironwood', 'Blue Heron', 'Cobalt', 'Sable', 'Harrow', 'Pemberton', 'Vantage', 'Juniper'];
  var COMPANY_B = ['Industries', 'Holdings', 'Trading Co', 'Works', 'Partners', 'Systems',
    'Foods', 'Logistics', 'Textiles', 'Engineering'];

  /* Failure risk is driven by combinations, and the most important one is
     non-monotone in growth: OVERTRADING - growing fast on a thin margin with
     no cash - is a classic way to fail, and so is not growing at all. A
     linear model forced to pick one sign for growth gets the fast-growing,
     cash-poor company exactly backwards. Leverage behaves the same way: it is
     only dangerous when the runway is also short. */
  function generateCompanies(n, seed) {
    var rnd = mulberry32(seed || 777);
    var rows = [];

    for (var i = 0; i < n; i++) {
      var sector = SECTORS[Math.floor(rnd() * SECTORS.length)];
      var revenue = Math.exp(12.4 + gauss(rnd) * 1.25);
      var margin = 0.075 + gauss(rnd) * 0.105;
      var netProfit = revenue * margin;
      var assets = revenue * (0.55 + rnd() * 1.5);
      var leverage = clamp(0.30 + gauss(rnd) * 0.23, 0.03, 1.30);
      var liabilities = assets * leverage;
      var currentAssets = assets * clamp(0.30 + gauss(rnd) * 0.13, 0.05, 0.80);
      var currentLiabs = Math.min(liabilities * 0.92,
                                  assets * clamp(0.23 + gauss(rnd) * 0.11, 0.03, 0.70));
      var cashMonths = Math.max(0.1, Math.exp(1.05 + gauss(rnd) * 0.85));
      var growth = gauss(rnd) * 0.21 + 0.05;
      var interest = liabilities * (0.055 + rnd() * 0.06);

      var debtToAssets = liabilities / assets;
      var currentRatio = currentAssets / Math.max(1, currentLiabs);
      var coverage = (netProfit + interest) / Math.max(1, interest);
      var roa = netProfit / assets;

      /* --- the failure patterns ----------------------------------------- */
      /* Leverage squeeze: borrowed heavily, nothing left to service it with. */
      var leverageSqueeze = (debtToAssets > 0.62 && cashMonths < 3.2) ? 1 : 0;
      /* Overtrading: growth outrunning the working capital behind it. */
      var overtrading = (growth > 0.28 && cashMonths < 3.5 && margin < 0.07) ? 1 : 0;
      /* Margin collapse: no profit and no growth to trade out of it. */
      var marginCollapse = (margin < 0.015 && growth < 0.03) ? 1 : 0;
      /* Coverage failure: earnings no longer clear the financing bill and
         short-term obligations are already tight. */
      var coverageFail = (coverage < 1.6 && currentRatio < 1.25) ? 1 : 0;
      /* The protective pattern, which is equally a conjunction. */
      var fortress = (cashMonths > 6 && debtToAssets < 0.42 && margin > 0.08) ? 1 : 0;

      var logit = -3.30
        + 2.95 * leverageSqueeze
        + 2.70 * overtrading
        + 2.55 * marginCollapse
        + 2.20 * coverageFail
        - 2.00 * fortress
        + 0.55 * clamp(debtToAssets, 0, 1.3)
        + 0.40 * (roa < -0.02 ? 1 : 0)
        - 0.35 * (margin > 0.15 ? 1 : 0)
        + gauss(rnd) * 0.32;

      var failed = rnd() < sigmoid(logit) ? 1 : 0;

      rows.push({
        company_id: 'CO-' + String(2100 + i),
        company_name: COMPANY_A[Math.floor(rnd() * COMPANY_A.length)] + ' ' +
                      COMPANY_B[Math.floor(rnd() * COMPANY_B.length)],
        sector: sector,
        annual_revenue: Math.round(revenue),
        net_profit: Math.round(netProfit),
        total_assets: Math.round(assets),
        total_liabilities: Math.round(liabilities),
        current_assets: Math.round(currentAssets),
        current_liabilities: Math.round(currentLiabs),
        cash_reserve_months: Math.round(cashMonths * 10) / 10,
        revenue_growth_pct: Math.round(growth * 1000) / 10,
        interest_expense: Math.round(interest),
        failed_within_24m: failed
      });
    }
    return rows;
  }

  var FIN_FIELDS = [
    { key: 'annual_revenue', label: 'Annual revenue', required: true, type: 'number',
      aliases: ['annual_revenue', 'revenue', 'turnover', 'sales', 'total_revenue', 'net_sales', 'income'] },
    { key: 'net_profit', label: 'Net profit', required: true, type: 'number',
      aliases: ['net_profit', 'profit', 'net_income', 'earnings', 'pat', 'bottom_line', 'net_earnings'] },
    { key: 'total_assets', label: 'Total assets', required: true, type: 'number',
      aliases: ['total_assets', 'assets', 'asset_total', 'total_asset'] },
    { key: 'total_liabilities', label: 'Total liabilities', required: true, type: 'number',
      aliases: ['total_liabilities', 'liabilities', 'total_debt', 'debt', 'total_liability'] },
    { key: 'cash_reserve_months', label: 'Cash reserve (months)', type: 'number',
      aliases: ['cash_reserve_months', 'cash_months', 'runway', 'cash_runway', 'months_of_cash', 'cash_reserve'] },
    { key: 'revenue_growth_pct', label: 'Revenue growth (%)', type: 'number',
      aliases: ['revenue_growth_pct', 'revenue_growth', 'growth', 'yoy_growth', 'sales_growth', 'growth_rate'] },
    { key: 'current_assets', label: 'Current assets', type: 'number',
      aliases: ['current_assets', 'curr_assets', 'short_term_assets'] },
    { key: 'current_liabilities', label: 'Current liabilities', type: 'number',
      aliases: ['current_liabilities', 'curr_liabilities', 'short_term_liabilities', 'payables'] },
    { key: 'interest_expense', label: 'Interest expense', type: 'number',
      aliases: ['interest_expense', 'interest', 'finance_cost', 'finance_charges', 'interest_paid'] },
    { key: 'company_name', label: 'Company name', type: 'text',
      aliases: ['company_name', 'company', 'name', 'entity', 'business_name', 'borrower', 'client'] },
    { key: 'sector', label: 'Sector', type: 'text',
      aliases: ['sector', 'industry', 'segment', 'vertical', 'business_type'] },
    { key: 'failed_within_24m', label: 'Known failure label (optional)', type: 'number',
      aliases: ['failed_within_24m', 'failed', 'default', 'is_default', 'bankrupt', 'label', 'target', 'distress'] }
  ];

  var FIN_FEATURES = [
    { key: 'net_margin',      label: 'Net margin',          hint: 'Net profit / revenue' },
    { key: 'debt_to_assets',  label: 'Debt-to-assets',      hint: 'Total liabilities / total assets' },
    { key: 'current_ratio',   label: 'Current ratio',       hint: 'Current assets / current liabilities' },
    { key: 'cash_months',     label: 'Cash runway',         hint: 'Months of operating expense held in cash' },
    { key: 'growth',          label: 'Revenue growth',      hint: 'Year-over-year revenue change' },
    { key: 'roa',             label: 'Return on assets',    hint: 'Net profit / total assets' },
    { key: 'equity_ratio',    label: 'Equity ratio',        hint: 'Net worth / total assets' },
    { key: 'coverage',        label: 'Interest coverage',   hint: 'Earnings before interest / interest expense' },
    { key: 'asset_turnover',  label: 'Asset turnover',      hint: 'Revenue / total assets' },
    { key: 'working_capital', label: 'Working capital pos.', hint: '(Current assets - current liabilities) / assets' }
  ];

  /* Derive the ten ratios from one financial record. Optional balance-sheet
     lines fall back to sector-typical proportions, which is what a credit
     analyst does with an incomplete file. */
  function financialsToFeatures(f) {
    var revenue = Math.max(1, num(f.annual_revenue, 1));
    var profit = num(f.net_profit, 0);
    var assets = Math.max(1, num(f.total_assets, revenue));
    var liabs = Math.max(0, num(f.total_liabilities, assets * 0.35));
    var ca = num(f.current_assets, null);
    var cl = num(f.current_liabilities, null);
    if (ca == null) ca = assets * 0.38;
    if (cl == null) cl = liabs * 0.52;
    var cashMonths = num(f.cash_reserve_months, 3);
    var growth = num(f.revenue_growth_pct, 0) / 100;
    var interest = num(f.interest_expense, null);
    if (interest == null) interest = liabs * 0.075;

    var margin = profit / revenue;
    var debtToAssets = liabs / assets;
    var currentRatio = ca / Math.max(1, cl);
    var roa = profit / assets;
    var equityRatio = (assets - liabs) / assets;
    var coverage = (profit + interest) / Math.max(1, interest);
    var turnover = revenue / assets;
    var workingCapital = (ca - cl) / assets;

    return {
      vector: [
        clamp(margin, -2, 2),
        clamp(debtToAssets, 0, 3),
        clamp(currentRatio, 0, 12),
        clamp(cashMonths, 0, 36),
        clamp(growth, -1, 3),
        clamp(roa, -2, 2),
        clamp(equityRatio, -2, 1),
        clamp(coverage, -20, 60),
        clamp(turnover, 0, 8),
        clamp(workingCapital, -2, 1)
      ],
      ratios: {
        net_margin: margin, debt_to_assets: debtToAssets, current_ratio: currentRatio,
        cash_months: cashMonths, growth: growth, roa: roa, equity_ratio: equityRatio,
        coverage: coverage, asset_turnover: turnover, working_capital: workingCapital,
        revenue: revenue, profit: profit, assets: assets, liabilities: liabs,
        net_worth: assets - liabs, current_assets: ca, current_liabilities: cl,
        interest_expense: interest
      }
    };
  }

  function companyRowToFinancials(r) {
    return {
      annual_revenue: r.annual_revenue, net_profit: r.net_profit,
      total_assets: r.total_assets, total_liabilities: r.total_liabilities,
      current_assets: r.current_assets, current_liabilities: r.current_liabilities,
      cash_reserve_months: r.cash_reserve_months, revenue_growth_pct: r.revenue_growth_pct,
      interest_expense: r.interest_expense
    };
  }

  /* ------------------------ Four-pillar health score ---------------------- */
  /* Transparent and deterministic: 25 points each for profitability, liquidity,
     solvency and growth. Piecewise-linear bands, published in full so a client
     can audit any score by hand. This runs alongside - not instead of - the
     model ensemble, which supplies the failure probability. */

  function band(value, lo, hi) { return clamp((value - lo) / (hi - lo), 0, 1) * 25; }

  function healthScore(ratios) {
    var profitability = band(ratios.net_margin, -0.10, 0.18);
    var liquidity = 0.6 * band(ratios.cash_months, 0, 6) + 0.4 * band(ratios.current_ratio, 0.6, 2.2);
    var solvency = 0.65 * band(1 - ratios.debt_to_assets, 0.10, 0.80) + 0.35 * band(ratios.coverage, 0.8, 6);
    var growth = 0.7 * band(ratios.growth, -0.15, 0.25) + 0.3 * band(ratios.roa, -0.05, 0.14);

    var pillars = [
      { key: 'profitability', label: 'Profitability', score: profitability,
        detail: 'Net margin ' + (ratios.net_margin * 100).toFixed(1) + '%' },
      { key: 'liquidity', label: 'Liquidity', score: liquidity,
        detail: ratios.cash_months.toFixed(1) + ' months cash, current ratio ' + ratios.current_ratio.toFixed(2) },
      { key: 'solvency', label: 'Solvency', score: solvency,
        detail: 'Debt/assets ' + (ratios.debt_to_assets * 100).toFixed(0) + '%, coverage ' + ratios.coverage.toFixed(1) + 'x' },
      { key: 'growth', label: 'Growth & returns', score: growth,
        detail: 'Growth ' + (ratios.growth * 100).toFixed(1) + '%, ROA ' + (ratios.roa * 100).toFixed(1) + '%' }
    ];

    var total = pillars.reduce(function (a, p) { return a + p.score; }, 0);
    return { total: total, pillars: pillars, grade: gradeOf(total) };
  }

  function gradeOf(total) {
    if (total >= 90) return { label: 'Excellent', key: 'excellent' };
    if (total >= 75) return { label: 'Strong', key: 'strong' };
    if (total >= 60) return { label: 'Good', key: 'good' };
    if (total >= 40) return { label: 'Fair', key: 'fair' };
    return { label: 'Needs improvement', key: 'weak' };
  }

  /* ============================== TEXT CORPUS ============================= */
  /* Labelled narrative used to train the transformer encoder. Phrases are the
     ones that actually appear in filings, credit memos and audit letters. */

  var DISTRESS_PHRASES = [
    'covenant waiver requested from lenders', 'auditor raised going concern doubt',
    'supplier payments delayed beyond terms', 'credit facility fully drawn',
    'restructuring advisor appointed this quarter', 'receivables ageing deteriorated sharply',
    'impairment charge recognised on goodwill', 'missed scheduled debt service payment',
    'headcount reduction announced across operations', 'order book declined for third quarter',
    'inventory write-down following weak demand', 'renegotiating terms with principal creditors',
    'cash conversion cycle lengthened materially', 'key customer contract not renewed',
    'operating losses widened year on year', 'bank has tightened the borrowing base'
  ];
  var HEALTHY_PHRASES = [
    'record free cash flow generated', 'term debt prepaid ahead of schedule',
    'gross margin expanded on pricing discipline', 'order book at an all time high',
    'net cash position at period end', 'dividend increased for the fourth year',
    'recurring revenue grew across segments', 'customer retention improved materially',
    'working capital released from inventory', 'credit rating outlook revised to positive',
    'new facility secured on improved terms', 'operating leverage drove earnings growth',
    'receivables collected within agreed terms', 'capacity utilisation at record levels',
    'covenant headroom comfortable throughout', 'audit completed with no qualifications'
  ];
  var NEUTRAL_TAILS = [
    'management commentary for the period', 'as disclosed in the quarterly review',
    'per the board reporting pack', 'noted in the finance director statement',
    'reported to the credit committee', 'summarised for the lending review'
  ];

  /* Negated pairs are the reason this needs attention rather than a keyword
     list. Each pair uses the SAME content words with opposite meaning, so a
     model that scores tokens independently cannot separate them - it has to
     read "no" and "not" in context. */
  var NEGATION_PAIRS = [
    ['no covenant waiver was required this period', 'the covenant waiver was not granted by lenders'],
    ['the auditor raised no going concern doubt', 'the auditor would not remove the going concern paragraph'],
    ['supplier payments were not delayed at any point', 'supplier payments were not brought back within terms'],
    ['the credit facility is not drawn', 'the credit facility could not be extended'],
    ['no impairment charge was necessary', 'the impairment charge could not be avoided'],
    ['no headcount reduction is planned', 'the headcount reduction did not deliver the saving'],
    ['debt service has never been missed', 'the missed debt service has not been cured'],
    ['margin did not compress despite input costs', 'margin expansion did not materialise'],
    ['receivables ageing has not deteriorated', 'receivables ageing has not recovered'],
    ['the order book did not decline this quarter', 'the order book has not recovered since']
  ];

  function buildTextCorpus(seed) {
    var rnd = mulberry32(seed || 31);
    var docs = [], labels = [];
    var i, j;

    for (i = 0; i < DISTRESS_PHRASES.length; i++) {
      for (j = 0; j < 3; j++) {
        var a = DISTRESS_PHRASES[i];
        var b = j === 0 ? '' : ' ' + DISTRESS_PHRASES[Math.floor(rnd() * DISTRESS_PHRASES.length)];
        var t = j === 2 ? ' ' + NEUTRAL_TAILS[Math.floor(rnd() * NEUTRAL_TAILS.length)] : '';
        docs.push(a + b + t);
        labels.push(1);
      }
    }
    for (i = 0; i < HEALTHY_PHRASES.length; i++) {
      for (j = 0; j < 3; j++) {
        var c = HEALTHY_PHRASES[i];
        var d = j === 0 ? '' : ' ' + HEALTHY_PHRASES[Math.floor(rnd() * HEALTHY_PHRASES.length)];
        var t2 = j === 2 ? ' ' + NEUTRAL_TAILS[Math.floor(rnd() * NEUTRAL_TAILS.length)] : '';
        docs.push(c + d + t2);
        labels.push(0);
      }
    }

    /* Negated pairs: identical vocabulary, opposite label. */
    for (i = 0; i < NEGATION_PAIRS.length; i++) {
      for (j = 0; j < 2; j++) {
        var tail = j === 1 ? ' ' + NEUTRAL_TAILS[Math.floor(rnd() * NEUTRAL_TAILS.length)] : '';
        docs.push(NEGATION_PAIRS[i][0] + tail);
        labels.push(0);
        docs.push(NEGATION_PAIRS[i][1] + tail);
        labels.push(1);
      }
    }

    /* Mixed statements: the leading clause sets the label, so the encoder has
       to weight tokens by position and context rather than count them. */
    for (i = 0; i < 12; i++) {
      docs.push(DISTRESS_PHRASES[Math.floor(rnd() * DISTRESS_PHRASES.length)] + ' although ' +
                HEALTHY_PHRASES[Math.floor(rnd() * HEALTHY_PHRASES.length)]);
      labels.push(1);
      docs.push(HEALTHY_PHRASES[Math.floor(rnd() * HEALTHY_PHRASES.length)] + ' despite ' +
                DISTRESS_PHRASES[Math.floor(rnd() * DISTRESS_PHRASES.length)]);
      labels.push(0);
    }
    return { docs: docs, labels: labels };
  }

  /* ================================ CSV I/O ============================== */

  /* RFC4180-style parser: handles quoted fields, embedded commas, escaped
     quotes and both newline conventions. Delimiter is sniffed from the header. */
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    var firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
    var delim = ',';
    [';', '\t', '|'].forEach(function (d) {
      if (firstLine.split(d).length > firstLine.split(delim).length) delim = d;
    });

    var rows = [], field = '', row = [], inQuotes = false, i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === delim) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.length && r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) return { headers: [], rows: [], delimiter: delim };

    var headers = rows[0].map(function (h, idx) {
      var name = String(h).trim();
      return name || ('column_' + (idx + 1));
    });
    var out = [];
    for (i = 1; i < rows.length; i++) {
      var obj = {};
      for (var c = 0; c < headers.length; c++) obj[headers[c]] = (rows[i][c] != null ? String(rows[i][c]).trim() : '');
      out.push(obj);
    }
    return { headers: headers, rows: out, delimiter: delim };
  }

  function toCSV(headers, rows) {
    function esc(v) {
      var s = (v == null) ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [headers.map(esc).join(',')];
    rows.forEach(function (r) {
      lines.push(headers.map(function (h) { return esc(r[h]); }).join(','));
    });
    return lines.join('\r\n');
  }

  function objectsToCSV(rows) {
    if (!rows.length) return '';
    var headers = Object.keys(rows[0]);
    return toCSV(headers, rows);
  }

  /* ------------------------- Sensitive data guard ------------------------ */
  /* US deployment makes this worth having rather than merely nice.

     A file containing full card numbers puts whoever holds it inside PCI DSS
     scope, and a file containing Social Security numbers engages state breach
     notification law in every state that has one. Neither is something a
     customer should discover after the fact, and neither is something this
     product needs: the models score behaviour - amount, timing, channel,
     velocity - and never look at an account identifier.

     So the platform detects those columns on upload and says so, rather than
     silently accepting them. Detection is deliberately conservative about
     card numbers - a Luhn check on the digits, not just "looks numeric" -
     because crying wolf on an order-reference column would train people to
     ignore the warning. */

  function luhnValid(digits) {
    var sum = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var n = digits.charCodeAt(i) - 48;
      if (n < 0 || n > 9) return false;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
  }

  var SENSITIVE_NAME_PATTERNS = [
    { re: /(^|_)(pan|card_?(no|num|number)|cc_?(no|num|number)|credit_?card)($|_)/, kind: 'card number' },
    { re: /(^|_)(ssn|social_?security|tax_?id|ein|itin)($|_)/, kind: 'government ID' },
    { re: /(^|_)(cvv|cvc|csc|security_?code|pin)($|_)/, kind: 'card security code' },
    { re: /(^|_)(routing|iban|sort_?code|account_?(no|num|number)|bank_?account)($|_)/, kind: 'bank account number' },
    { re: /(^|_)(dob|date_?of_?birth|birth_?date)($|_)/, kind: 'date of birth' },
    { re: /(^|_)(passport|drivers?_?licen[sc]e|national_?id)($|_)/, kind: 'identity document' }
  ];

  var SSN_RE = /^\d{3}-\d{2}-\d{4}$/;

  function inspectSensitive(rows, headers, sampleSize) {
    var sample = rows.slice(0, sampleSize || 200);
    var found = [];

    headers.forEach(function (h) {
      var norm = normaliseHeader(h);
      var byName = null;
      for (var i = 0; i < SENSITIVE_NAME_PATTERNS.length; i++) {
        if (SENSITIVE_NAME_PATTERNS[i].re.test(norm)) { byName = SENSITIVE_NAME_PATTERNS[i].kind; break; }
      }

      var cardHits = 0, ssnHits = 0, checked = 0;
      for (var r = 0; r < sample.length; r++) {
        var raw = sample[r][h];
        if (raw == null || raw === '') continue;
        checked++;
        var str = String(raw).trim();
        if (SSN_RE.test(str)) { ssnHits++; continue; }
        var digits = str.replace(/[\s-]/g, '');
        if (/^\d{13,19}$/.test(digits) && luhnValid(digits)) cardHits++;
      }

      /* A single Luhn-valid value is a coincidence; a column of them is a
         column of card numbers. */
      var byValue = null;
      if (checked >= 4 && cardHits / checked > 0.6) byValue = 'card number';
      else if (checked >= 4 && ssnHits / checked > 0.6) byValue = 'Social Security number';

      if (byName || byValue) {
        found.push({
          header: h,
          kind: byValue || byName,
          detectedBy: byValue ? 'values' : 'column name',
          matches: byValue ? Math.max(cardHits, ssnHits) : 0,
          checked: checked
        });
      }
    });

    return {
      columns: found,
      severity: found.some(function (f) {
        return /card number|Social Security|security code/.test(f.kind);
      }) ? 'high' : (found.length ? 'medium' : 'none')
    };
  }

  /* Keep the last four digits so an investigator can still recognise a card
     across rows, and drop everything that makes the number usable. */
  function maskValue(value) {
    var str = String(value == null ? '' : value);
    var digits = str.replace(/[\s-]/g, '');
    if (/^\d{9,19}$/.test(digits)) return '•••• ' + digits.slice(-4);
    if (SSN_RE.test(str)) return '•••-••-' + str.slice(-4);
    if (str.length <= 4) return '••••';
    return str.slice(0, 1) + '••••' + str.slice(-1);
  }

  /* ---------------------------- Column mapping --------------------------- */

  function normaliseHeader(h) {
    return String(h).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  /* Score each header against a field's aliases: exact normalised match wins,
     then token overlap, then substring containment. Every header is offered in
     the dropdown regardless, so an analyst can always override the guess. */
  function autoMap(headers, fields) {
    var mapping = {}, used = {};
    var normed = headers.map(function (h) { return { raw: h, n: normaliseHeader(h) }; });

    fields.forEach(function (field) {
      var best = null;
      normed.forEach(function (h) {
        if (used[h.raw]) return;
        var score = 0;
        for (var i = 0; i < field.aliases.length; i++) {
          var a = normaliseHeader(field.aliases[i]);
          if (h.n === a) { score = Math.max(score, 100); continue; }
          if (h.n.indexOf(a) >= 0 || a.indexOf(h.n) >= 0) {
            var ratio = Math.min(h.n.length, a.length) / Math.max(h.n.length, a.length);
            score = Math.max(score, 45 + ratio * 40);
          }
          var ht = h.n.split('_'), at = a.split('_');
          var overlap = ht.filter(function (t) { return t.length > 2 && at.indexOf(t) >= 0; }).length;
          if (overlap) score = Math.max(score, 30 + overlap * 14);
        }
        if (score > 0 && (!best || score > best.score)) best = { raw: h.raw, score: score };
      });
      if (best && best.score >= 45) {
        mapping[field.key] = best.raw;
        used[best.raw] = true;
      }
    });
    return mapping;
  }

  function mappingCoverage(mapping, fields) {
    var total = fields.length, hit = 0, missingRequired = [];
    fields.forEach(function (f) {
      if (mapping[f.key]) hit++;
      else if (f.required) missingRequired.push(f.label);
    });
    return { mapped: hit, total: total, missingRequired: missingRequired };
  }

  /* --------------------------------------------------------------- exports */

  global.BRI.Data = {
    generateTransactions: generateTransactions,
    generateCompanies: generateCompanies,
    buildTxnFeatures: buildTxnFeatures,
    financialsToFeatures: financialsToFeatures,
    companyRowToFinancials: companyRowToFinancials,
    healthScore: healthScore,
    gradeOf: gradeOf,
    buildTextCorpus: buildTextCorpus,
    parseCSV: parseCSV,
    toCSV: toCSV,
    objectsToCSV: objectsToCSV,
    autoMap: autoMap,
    inspectSensitive: inspectSensitive,
    maskValue: maskValue,
    luhnValid: luhnValid,
    mappingCoverage: mappingCoverage,
    normaliseHeader: normaliseHeader,
    num: num,
    truthy: truthy,
    TXN_FIELDS: TXN_FIELDS,
    TXN_FEATURES: TXN_FEATURES,
    FIN_FIELDS: FIN_FIELDS,
    FIN_FEATURES: FIN_FEATURES,
    SECTORS: SECTORS
  };
})(typeof window !== 'undefined' ? window : globalThis);
