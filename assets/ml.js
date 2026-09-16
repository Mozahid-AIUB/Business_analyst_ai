/* ============================================================================
   ml.js - BRI.ML
   Real, in-page implementations of the platform's research methods:
     - CART decision trees (Gini classification + XGBoost second-order regression)
     - Random Forest (bootstrap + feature subsampling + out-of-bag scoring)
     - Gradient-Boosted Trees on the XGBoost objective
     - Logistic Regression (standardised, L2, gradient descent)
     - Permutation SHAP, tree path-contributions, LIME ridge surrogate
     - Single-block transformer encoder (self-attention + residual, backprop)
     - Evaluation: ROC-AUC, precision, recall, F1, accuracy, confusion matrix
   No ML library is loaded. Everything here executes when the platform scores.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rnd) {
    var u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    var e = Math.exp(z);
    return e / (1 + e);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function mean(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : 0;
  }

  function stdev(arr) {
    var m = mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(arr.length > 1 ? s / (arr.length - 1) : 0);
  }

  function sampleFeatures(nFeat, k, rnd) {
    var pool = [], i;
    for (i = 0; i < nFeat; i++) pool.push(i);
    for (i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, Math.max(1, Math.min(nFeat, k)));
  }

  /* ------------------------------------------------------------- binning */
  /* Both tree learners use the histogram method: each feature is quantised
     once into at most `maxBins` quantile buckets, and every split search then
     accumulates counts into that fixed grid instead of re-sorting the rows.
     This is the same trick as XGBoost's `tree_method=hist`, and it turns the
     per-node cost from O(n log n) per feature into O(n + bins). Trees still
     store real-valued thresholds, so prediction is unchanged. */

  function binIndex(v, cuts) {
    var lo = 0, hi = cuts.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (v <= cuts[mid]) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  function makeBinning(X, maxBins) {
    var n = X.length, d = X[0].length, f, i, b;
    maxBins = maxBins || 32;
    var edges = [];

    for (f = 0; f < d; f++) {
      var col = new Array(n);
      for (i = 0; i < n; i++) col[i] = X[i][f];
      col.sort(function (a, p) { return a - p; });
      var uniq = [];
      for (i = 0; i < n; i++) if (i === 0 || col[i] !== col[i - 1]) uniq.push(col[i]);
      var cuts = [];
      if (uniq.length <= maxBins) {
        for (i = 0; i < uniq.length - 1; i++) cuts.push((uniq[i] + uniq[i + 1]) / 2);
      } else {
        for (b = 1; b < maxBins; b++) {
          var q = col[Math.min(n - 1, Math.floor(b * n / maxBins))];
          if (!cuts.length || q > cuts[cuts.length - 1]) cuts.push(q);
        }
      }
      edges.push(cuts);
    }

    var B = [];
    for (i = 0; i < n; i++) {
      var row = new Uint8Array(d);
      for (f = 0; f < d; f++) row[f] = binIndex(X[i][f], edges[f]);
      B.push(row);
    }
    return { edges: edges, B: B };
  }

  /* ------------------------------------------------------- CART: Gini tree */
  /* Classification tree used by the Random Forest. Splits maximise the
     weighted Gini impurity decrease over the binned grid. */

  function buildGiniNode(bin, y, idx, depth, opt, rnd, imp) {
    var B = bin.B, edges = bin.edges;
    var n = idx.length, pos = 0, i, k;
    for (i = 0; i < n; i++) pos += y[idx[i]];
    var p = pos / n;
    var node = { n: n, value: p };

    if (depth >= opt.maxDepth || n < opt.minSamplesSplit || pos === 0 || pos === n) {
      node.leaf = true;
      return node;
    }

    var parentCost = n * 2 * p * (1 - p);
    var feats = sampleFeatures(edges.length, opt.maxFeatures, rnd);
    var best = null;

    for (var fi = 0; fi < feats.length; fi++) {
      var f = feats[fi], cuts = edges[f], nb = cuts.length + 1;
      if (nb < 2) continue;
      var cnt = new Float64Array(nb), pcount = new Float64Array(nb);
      for (i = 0; i < n; i++) {
        var r = idx[i], b = B[r][f];
        cnt[b]++; pcount[b] += y[r];
      }
      var lN = 0, lPos = 0;
      for (k = 0; k < nb - 1; k++) {
        lN += cnt[k]; lPos += pcount[k];
        var rN = n - lN;
        if (lN < opt.minSamplesLeaf || rN < opt.minSamplesLeaf) continue;
        var pl = lPos / lN, pr = (pos - lPos) / rN;
        var gain = parentCost - (lN * 2 * pl * (1 - pl) + rN * 2 * pr * (1 - pr));
        if (!best || gain > best.gain) best = { gain: gain, f: f, bin: k, thr: cuts[k] };
      }
    }

    if (!best || best.gain <= 1e-12) { node.leaf = true; return node; }

    var L = [], R = [];
    for (i = 0; i < n; i++) {
      if (B[idx[i]][best.f] <= best.bin) L.push(idx[i]); else R.push(idx[i]);
    }
    if (!L.length || !R.length) { node.leaf = true; return node; }

    if (imp) imp[best.f] += best.gain;
    node.leaf = false;
    node.feature = best.f;
    node.threshold = best.thr;
    node.left = buildGiniNode(bin, y, L, depth + 1, opt, rnd, imp);
    node.right = buildGiniNode(bin, y, R, depth + 1, opt, rnd, imp);
    return node;
  }

  /* ---------------------------------------- CART: XGBoost second-order tree */
  /* Regression tree on gradients/hessians of the logistic loss. Split gain is
     the XGBoost structure score:
        gain = 0.5 * [ GL^2/(HL+L) + GR^2/(HR+L) - G^2/(H+L) ] - gamma
     Leaf weight is w = -G / (H + lambda). */

  function buildXgbNode(bin, g, h, idx, depth, opt, rnd, imp) {
    var B = bin.B, edges = bin.edges;
    var n = idx.length, G = 0, H = 0, i, k;
    for (i = 0; i < n; i++) { G += g[idx[i]]; H += h[idx[i]]; }

    var node = { n: n, value: -G / (H + opt.lambda) };
    if (depth >= opt.maxDepth || n < opt.minSamplesSplit) { node.leaf = true; return node; }

    var rootScore = (G * G) / (H + opt.lambda);
    var feats = sampleFeatures(edges.length, opt.colsample, rnd);
    var best = null;

    for (var fi = 0; fi < feats.length; fi++) {
      var f = feats[fi], cuts = edges[f], nb = cuts.length + 1;
      if (nb < 2) continue;
      var gh = new Float64Array(nb), hh = new Float64Array(nb), cnt = new Float64Array(nb);
      for (i = 0; i < n; i++) {
        var r = idx[i], b = B[r][f];
        gh[b] += g[r]; hh[b] += h[r]; cnt[b]++;
      }
      var GL = 0, HL = 0, lN = 0;
      for (k = 0; k < nb - 1; k++) {
        GL += gh[k]; HL += hh[k]; lN += cnt[k];
        var HR = H - HL;
        if (HL < opt.minChildWeight || HR < opt.minChildWeight) continue;
        if (lN < opt.minSamplesLeaf || (n - lN) < opt.minSamplesLeaf) continue;
        var GR = G - GL;
        var gain = 0.5 * ((GL * GL) / (HL + opt.lambda) + (GR * GR) / (HR + opt.lambda) - rootScore) - opt.gamma;
        if (!best || gain > best.gain) best = { gain: gain, f: f, bin: k, thr: cuts[k] };
      }
    }

    if (!best || best.gain <= 0) { node.leaf = true; return node; }

    var L = [], R = [];
    for (i = 0; i < n; i++) {
      if (B[idx[i]][best.f] <= best.bin) L.push(idx[i]); else R.push(idx[i]);
    }
    if (!L.length || !R.length) { node.leaf = true; return node; }

    if (imp) imp[best.f] += best.gain;
    node.leaf = false;
    node.feature = best.f;
    node.threshold = best.thr;
    node.left = buildXgbNode(bin, g, h, L, depth + 1, opt, rnd, imp);
    node.right = buildXgbNode(bin, g, h, R, depth + 1, opt, rnd, imp);
    return node;
  }

  function predictTree(node, x) {
    while (!node.leaf) node = (x[node.feature] <= node.threshold) ? node.left : node.right;
    return node.value;
  }

  function treeDepth(node) {
    if (node.leaf) return 1;
    return 1 + Math.max(treeDepth(node.left), treeDepth(node.right));
  }

  function countLeaves(node) {
    if (node.leaf) return 1;
    return countLeaves(node.left) + countLeaves(node.right);
  }

  /* --------------------------------------------------------- Random Forest */

  function RandomForest(opt) {
    this.opt = Object.assign({
      nTrees: 60, maxDepth: 8, minSamplesSplit: 12, minSamplesLeaf: 4,
      maxFeatures: null, seed: 7
    }, opt || {});
    this.trees = [];
    this.importance = [];
    this.oobAuc = null;
  }

  RandomForest.prototype.fit = function (X, y) {
    var n = X.length, d = X[0].length, i, t;
    var opt = this.opt;
    if (!opt.maxFeatures) opt.maxFeatures = Math.max(2, Math.round(Math.sqrt(d)));
    var rnd = mulberry32(opt.seed);
    var bin = makeBinning(X, opt.maxBins || 32);

    this.importance = new Array(d).fill(0);
    this.trees = [];
    var oobSum = new Array(n).fill(0), oobCnt = new Array(n).fill(0);

    for (t = 0; t < opt.nTrees; t++) {
      var bag = new Array(n).fill(false), idx = [];
      for (i = 0; i < n; i++) {
        var r = Math.floor(rnd() * n);
        idx.push(r);
        bag[r] = true;
      }
      var tree = buildGiniNode(bin, y, idx, 0, opt, rnd, this.importance);
      this.trees.push(tree);
      for (i = 0; i < n; i++) {
        if (!bag[i]) { oobSum[i] += predictTree(tree, X[i]); oobCnt[i]++; }
      }
    }

    var oobScore = [], oobY = [];
    for (i = 0; i < n; i++) {
      if (oobCnt[i] > 0) { oobScore.push(oobSum[i] / oobCnt[i]); oobY.push(y[i]); }
    }
    this.oobAuc = oobScore.length > 20 ? rocAuc(oobY, oobScore) : null;
    this.oobCoverage = oobScore.length / n;

    var tot = this.importance.reduce(function (a, b) { return a + b; }, 0) || 1;
    this.importanceNorm = this.importance.map(function (v) { return v / tot; });
    return this;
  };

  RandomForest.prototype.predictProba = function (x) {
    var s = 0;
    for (var t = 0; t < this.trees.length; t++) s += predictTree(this.trees[t], x);
    return s / this.trees.length;
  };

  /* Additive path decomposition (tree-interpreter style): every step down a
     tree attributes the change in node value to the splitting feature, so
     bias + sum(contributions) reproduces the forest probability exactly. */
  RandomForest.prototype.pathContributions = function (x, d) {
    var contrib = new Array(d).fill(0), bias = 0;
    for (var t = 0; t < this.trees.length; t++) {
      var node = this.trees[t];
      bias += node.value;
      while (!node.leaf) {
        var child = (x[node.feature] <= node.threshold) ? node.left : node.right;
        contrib[node.feature] += child.value - node.value;
        node = child;
      }
    }
    var k = this.trees.length;
    for (var i = 0; i < d; i++) contrib[i] /= k;
    return { bias: bias / k, contributions: contrib };
  };

  RandomForest.prototype.stats = function () {
    var depths = this.trees.map(treeDepth), leaves = this.trees.map(countLeaves);
    return {
      trees: this.trees.length,
      avgDepth: mean(depths),
      maxDepth: Math.max.apply(null, depths),
      avgLeaves: mean(leaves),
      totalNodes: leaves.reduce(function (a, b) { return a + 2 * b - 1; }, 0)
    };
  };

  /* ------------------------------------------------- Gradient-Boosted Trees */

  function GradientBoosting(opt) {
    this.opt = Object.assign({
      nRounds: 120, maxDepth: 3, eta: 0.12, lambda: 1.0, gamma: 0.0,
      subsample: 0.8, colsample: null, minChildWeight: 1.0,
      minSamplesSplit: 10, minSamplesLeaf: 3, seed: 11
    }, opt || {});
    this.trees = [];
    this.base = 0;
    this.importance = [];
    this.trainLoss = [];
  }

  GradientBoosting.prototype.fit = function (X, y) {
    var n = X.length, d = X[0].length, i, m;
    var opt = this.opt;
    if (!opt.colsample) opt.colsample = Math.max(2, Math.round(d * 0.8));
    var rnd = mulberry32(opt.seed);
    var bin = makeBinning(X, opt.maxBins || 32);

    var pBar = clamp(mean(y), 1e-6, 1 - 1e-6);
    this.base = Math.log(pBar / (1 - pBar));
    var F = new Array(n).fill(this.base);
    this.trees = [];
    this.importance = new Array(d).fill(0);
    this.trainLoss = [];

    var g = new Array(n), h = new Array(n);

    for (m = 0; m < opt.nRounds; m++) {
      var loss = 0;
      for (i = 0; i < n; i++) {
        var p = sigmoid(F[i]);
        g[i] = p - y[i];
        h[i] = Math.max(p * (1 - p), 1e-6);
        loss -= y[i] * Math.log(clamp(p, 1e-12, 1)) + (1 - y[i]) * Math.log(clamp(1 - p, 1e-12, 1));
      }
      this.trainLoss.push(loss / n);

      var idx = [];
      for (i = 0; i < n; i++) if (rnd() < opt.subsample) idx.push(i);
      if (idx.length < 20) { idx = []; for (i = 0; i < n; i++) idx.push(i); }

      var tree = buildXgbNode(bin, g, h, idx, 0, opt, rnd, this.importance);
      this.trees.push(tree);
      for (i = 0; i < n; i++) F[i] += opt.eta * predictTree(tree, X[i]);
    }

    var tot = this.importance.reduce(function (a, b) { return a + b; }, 0) || 1;
    this.importanceNorm = this.importance.map(function (v) { return v / tot; });
    return this;
  };

  GradientBoosting.prototype.margin = function (x) {
    var f = this.base;
    for (var t = 0; t < this.trees.length; t++) f += this.opt.eta * predictTree(this.trees[t], x);
    return f;
  };

  GradientBoosting.prototype.predictProba = function (x) { return sigmoid(this.margin(x)); };

  /* Path decomposition in log-odds space; bias + sum(contributions) = margin. */
  GradientBoosting.prototype.pathContributions = function (x, d) {
    var contrib = new Array(d).fill(0), bias = this.base, eta = this.opt.eta;
    for (var t = 0; t < this.trees.length; t++) {
      var node = this.trees[t];
      bias += eta * node.value;
      while (!node.leaf) {
        var child = (x[node.feature] <= node.threshold) ? node.left : node.right;
        contrib[node.feature] += eta * (child.value - node.value);
        node = child;
      }
    }
    return { bias: bias, contributions: contrib };
  };

  GradientBoosting.prototype.stats = function () {
    var depths = this.trees.map(treeDepth), leaves = this.trees.map(countLeaves);
    return {
      rounds: this.trees.length,
      avgDepth: mean(depths),
      maxDepth: Math.max.apply(null, depths),
      avgLeaves: mean(leaves),
      finalLoss: this.trainLoss.length ? this.trainLoss[this.trainLoss.length - 1] : null
    };
  };

  /* ---------------------------------------------------- Logistic Regression */

  function LogisticRegression(opt) {
    this.opt = Object.assign({ epochs: 500, lr: 0.35, l2: 0.002 }, opt || {});
    this.w = null; this.b = 0; this.mu = null; this.sd = null;
  }

  LogisticRegression.prototype.fit = function (X, y) {
    var n = X.length, d = X[0].length, i, j;
    this.mu = new Array(d).fill(0);
    this.sd = new Array(d).fill(1);
    for (j = 0; j < d; j++) {
      var col = [];
      for (i = 0; i < n; i++) col.push(X[i][j]);
      this.mu[j] = mean(col);
      this.sd[j] = stdev(col) || 1;
    }
    var Z = [];
    for (i = 0; i < n; i++) {
      var row = new Array(d);
      for (j = 0; j < d; j++) row[j] = (X[i][j] - this.mu[j]) / this.sd[j];
      Z.push(row);
    }

    this.w = new Array(d).fill(0);
    this.b = 0;
    for (var ep = 0; ep < this.opt.epochs; ep++) {
      var gw = new Array(d).fill(0), gb = 0;
      for (i = 0; i < n; i++) {
        var z = this.b;
        for (j = 0; j < d; j++) z += this.w[j] * Z[i][j];
        var err = sigmoid(z) - y[i];
        gb += err;
        for (j = 0; j < d; j++) gw[j] += err * Z[i][j];
      }
      var step = this.opt.lr / (1 + ep * 0.004);
      this.b -= step * gb / n;
      for (j = 0; j < d; j++) this.w[j] -= step * (gw[j] / n + this.opt.l2 * this.w[j]);
    }
    return this;
  };

  LogisticRegression.prototype.margin = function (x) {
    var z = this.b;
    for (var j = 0; j < this.w.length; j++) z += this.w[j] * ((x[j] - this.mu[j]) / this.sd[j]);
    return z;
  };

  LogisticRegression.prototype.predictProba = function (x) { return sigmoid(this.margin(x)); };

  LogisticRegression.prototype.coefficients = function () { return this.w.slice(); };

  LogisticRegression.prototype.oddsRatios = function () {
    return this.w.map(function (v) { return Math.exp(v); });
  };

  /* ------------------------------------------------------------ Evaluation */

  function rocAuc(y, score) {
    var n = y.length, i, i2;
    var pairs = [];
    for (i = 0; i < n; i++) pairs.push({ s: score[i], y: y[i] });
    pairs.sort(function (a, b) { return a.s - b.s; });
    var ranks = new Array(n);
    i = 0;
    while (i < n) {
      var j = i;
      while (j + 1 < n && pairs[j + 1].s === pairs[i].s) j++;
      var avg = (i + j) / 2 + 1;
      for (i2 = i; i2 <= j; i2++) ranks[i2] = avg;
      i = j + 1;
    }
    var nP = 0, nN = 0, sumRankP = 0;
    for (i = 0; i < n; i++) {
      if (pairs[i].y === 1) { nP++; sumRankP += ranks[i]; } else nN++;
    }
    if (!nP || !nN) return null;
    return (sumRankP - nP * (nP + 1) / 2) / (nP * nN);
  }

  function rocCurve(y, score, maxPoints) {
    var n = y.length, i;
    var pairs = [];
    for (i = 0; i < n; i++) pairs.push({ s: score[i], y: y[i] });
    pairs.sort(function (a, b) { return b.s - a.s; });
    var nP = 0, nN = 0;
    for (i = 0; i < n; i++) { if (pairs[i].y === 1) nP++; else nN++; }
    var pts = [{ fpr: 0, tpr: 0, thr: 1 }];
    var tp = 0, fp = 0;
    var stride = Math.max(1, Math.floor(n / (maxPoints || 110)));
    for (i = 0; i < n; i++) {
      if (pairs[i].y === 1) tp++; else fp++;
      if (i % stride === 0 || i === n - 1) {
        pts.push({ fpr: nN ? fp / nN : 0, tpr: nP ? tp / nP : 0, thr: pairs[i].s });
      }
    }
    pts.push({ fpr: 1, tpr: 1, thr: 0 });
    return pts;
  }

  function confusion(y, score, thr) {
    var tp = 0, fp = 0, tn = 0, fn = 0;
    for (var i = 0; i < y.length; i++) {
      var pred = score[i] >= thr ? 1 : 0;
      if (y[i] === 1 && pred === 1) tp++;
      else if (y[i] === 0 && pred === 1) fp++;
      else if (y[i] === 0 && pred === 0) tn++;
      else fn++;
    }
    return { tp: tp, fp: fp, tn: tn, fn: fn };
  }

  function evaluate(y, score, thr) {
    var c = confusion(y, score, thr);
    var precision = (c.tp + c.fp) ? c.tp / (c.tp + c.fp) : 0;
    var recall = (c.tp + c.fn) ? c.tp / (c.tp + c.fn) : 0;
    var specificity = (c.tn + c.fp) ? c.tn / (c.tn + c.fp) : 0;
    var f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
    var acc = (c.tp + c.tn) / Math.max(1, y.length);
    return {
      threshold: thr, confusion: c, precision: precision, recall: recall,
      specificity: specificity, f1: f1, accuracy: acc,
      falsePositiveRate: (c.tn + c.fp) ? c.fp / (c.tn + c.fp) : 0,
      auc: rocAuc(y, score), n: y.length, positives: c.tp + c.fn
    };
  }

  /* Operating thresholds come from the held-out split, not from a default 0.5.
     Beta sets what the band is for: beta = 1 balances precision and recall and
     gives the "act now" cut-off; beta = 2 weights recall twice as heavily and
     gives the lower "review when convenient" cut-off. */
  function bestFBetaThreshold(y, score, beta) {
    var b2 = (beta == null ? 1 : beta) * (beta == null ? 1 : beta);
    var cands = score.slice().sort(function (a, b) { return a - b; });
    var step = Math.max(1, Math.floor(cands.length / 120));
    var best = { thr: 0.5, f: -1 };
    for (var i = 0; i < cands.length; i += step) {
      var e = evaluate(y, score, cands[i]);
      var denom = b2 * e.precision + e.recall;
      var f = denom ? (1 + b2) * e.precision * e.recall / denom : 0;
      if (f > best.f) best = { thr: cands[i], f: f };
    }
    return best.thr;
  }

  function bestF1Threshold(y, score) { return bestFBetaThreshold(y, score, 1); }

  /* -------------------------------------------------------- Explainability */

  /* Permutation-sampled Shapley values. Features are revealed in random order
     over a background sample; the marginal change each reveal causes is that
     feature's contribution. Satisfies local accuracy: base + sum(phi) = f(x). */
  function shapValues(predictFn, x, background, nPerm, seed) {
    var d = x.length, rnd = mulberry32(seed || 3), phi = new Array(d).fill(0);
    var order = [], i;
    for (i = 0; i < d; i++) order.push(i);

    for (var p = 0; p < nPerm; p++) {
      for (i = d - 1; i > 0; i--) {
        var j = Math.floor(rnd() * (i + 1));
        var t = order[i]; order[i] = order[j]; order[j] = t;
      }
      var z = background[Math.floor(rnd() * background.length)].slice();
      var prev = predictFn(z);
      for (i = 0; i < d; i++) {
        var f = order[i];
        z[f] = x[f];
        var cur = predictFn(z);
        phi[f] += cur - prev;
        prev = cur;
      }
    }
    for (i = 0; i < d; i++) phi[i] /= nPerm;

    var baseSum = 0;
    for (i = 0; i < background.length; i++) baseSum += predictFn(background[i]);
    return { base: baseSum / background.length, phi: phi, nPerm: nPerm };
  }

  /* Ridge solve via Gaussian elimination with partial pivoting. `penalty` may
     be a scalar or a per-coefficient array, so an intercept can be left
     unpenalised. */
  function solveRidgeP(A, b, penalty) {
    var d = b.length, i, j, k;
    var perCoef = Array.isArray(penalty);
    var M = [];
    for (i = 0; i < d; i++) {
      M.push(A[i].slice());
      M[i][i] += perCoef ? penalty[i] : penalty;
      M[i].push(b[i]);
    }
    for (i = 0; i < d; i++) {
      var piv = i;
      for (k = i + 1; k < d; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;
      if (Math.abs(M[i][i]) < 1e-12) continue;
      for (k = i + 1; k < d; k++) {
        var fac = M[k][i] / M[i][i];
        for (j = i; j <= d; j++) M[k][j] -= fac * M[i][j];
      }
    }
    var out = new Array(d).fill(0);
    for (i = d - 1; i >= 0; i--) {
      if (Math.abs(M[i][i]) < 1e-12) { out[i] = 0; continue; }
      var s = M[i][d];
      for (j = i + 1; j < d; j++) s -= M[i][j] * out[j];
      out[i] = s / M[i][i];
    }
    return out;
  }

  function solveRidge(A, b, alpha) { return solveRidgeP(A, b, alpha); }

  /* LIME: sample a neighbourhood around x, weight each sample by proximity,
     fit a weighted ridge regression. Its coefficients are the local linear
     surrogate the analyst reads, and localFit reports how well that surrogate
     tracks the real model nearby. */
  function limeExplain(predictFn, x, sigma, opt, seed) {
    opt = Object.assign({
      nSamples: 240,
      /* The neighbourhood has to be genuinely local. Perturbing by a full
         feature standard deviation samples most of the data space, where a
         tree ensemble is nowhere near linear and the surrogate fits worse
         than a constant. A third of an SD keeps the samples close enough for
         a line to mean something. */
      scale: 0.35,
      kernelWidth: null,
      alpha: 0.4
    }, opt || {});
    var d = x.length, rnd = mulberry32(seed || 5), i, j, k;
    var kw = opt.kernelWidth || Math.sqrt(d) * 0.40;

    var Z = [], w = [], yv = [];
    var fx = predictFn(x);
    for (i = 0; i < opt.nSamples; i++) {
      var z = new Array(d), zs = new Array(d + 1), dist = 0;
      for (j = 0; j < d; j++) {
        var s = (sigma[j] || 1e-6) * opt.scale;
        var delta = gauss(rnd);
        z[j] = x[j] + delta * s;
        zs[j] = delta;
        dist += delta * delta;
      }
      zs[d] = 1;                                   /* intercept column */
      Z.push(zs);
      w.push(Math.exp(-dist / (kw * kw)));
      yv.push(predictFn(z) - fx);
    }

    /* Weighted ridge with an unpenalised intercept - without it the surrogate
       is forced through the origin and its R-squared can go negative. */
    var m = d + 1;
    var A = [], b = new Array(m).fill(0);
    for (i = 0; i < m; i++) A.push(new Array(m).fill(0));
    for (k = 0; k < Z.length; k++) {
      for (i = 0; i < m; i++) {
        b[i] += w[k] * Z[k][i] * yv[k];
        for (j = 0; j < m; j++) A[i][j] += w[k] * Z[k][i] * Z[k][j];
      }
    }
    var penalty = new Array(m).fill(opt.alpha);
    penalty[d] = 0;
    var full = solveRidgeP(A, b, penalty);
    var coef = full.slice(0, d);

    var ssTot = 0, ssRes = 0, wy = 0, wSum = 0;
    for (k = 0; k < Z.length; k++) { wy += w[k] * yv[k]; wSum += w[k]; }
    var ybar = wSum ? wy / wSum : 0;
    for (k = 0; k < Z.length; k++) {
      var pred = 0;
      for (j = 0; j < m; j++) pred += full[j] * Z[k][j];
      ssRes += w[k] * (yv[k] - pred) * (yv[k] - pred);
      ssTot += w[k] * (yv[k] - ybar) * (yv[k] - ybar);
    }
    return {
      coef: coef, intercept: full[d],
      localFit: ssTot > 0 ? 1 - ssRes / ssTot : 0,
      fx: fx, nSamples: opt.nSamples, scale: opt.scale
    };
  }

  /* ---------------------------------------------- Transformer text encoder */
  /* One encoder block: learned token embeddings + sinusoidal positions,
     single-head scaled dot-product self-attention, residual connection, mean
     pooling, linear head. Trained by backpropagation on a labelled in-page
     corpus of business and financial narrative. */

  function TextEncoder(opt) {
    this.opt = Object.assign({ dim: 12, maxLen: 26, lr: 0.08, epochs: 80, seed: 17 }, opt || {});
    this.vocab = {};
    this.vocabList = [];
    this.trained = false;
  }

  TextEncoder.prototype.tokenize = function (text) {
    return String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .filter(function (t) { return t.length > 1; })
      .slice(0, this.opt.maxLen);
  };

  TextEncoder.prototype.buildVocab = function (docs) {
    var self = this, counts = {};
    docs.forEach(function (doc) {
      self.tokenize(doc).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    this.vocabList = ['<unk>'].concat(Object.keys(counts));
    this.vocab = {};
    for (var i = 0; i < this.vocabList.length; i++) this.vocab[this.vocabList[i]] = i;
  };

  TextEncoder.prototype.ids = function (text) {
    var self = this;
    var t = this.tokenize(text).map(function (w) {
      return Object.prototype.hasOwnProperty.call(self.vocab, w) ? self.vocab[w] : 0;
    });
    return t.length ? t : [0];
  };

  function zeros2(r, c) {
    var m = [];
    for (var i = 0; i < r; i++) m.push(new Array(c).fill(0));
    return m;
  }

  TextEncoder.prototype.init = function () {
    var d = this.opt.dim, V = this.vocabList.length, rnd = mulberry32(this.opt.seed), i, j;
    var scale = 1 / Math.sqrt(d);
    function rmat(r, c) {
      var m = [];
      for (var a = 0; a < r; a++) {
        var row = new Array(c);
        for (var b = 0; b < c; b++) row[b] = gauss(rnd) * scale;
        m.push(row);
      }
      return m;
    }
    this.emb = rmat(V, d);
    this.Wq = rmat(d, d);
    this.Wk = rmat(d, d);
    this.Wv = rmat(d, d);
    this.w = new Array(d).fill(0);
    this.b = 0;
    this.pos = zeros2(this.opt.maxLen, d);
    for (i = 0; i < this.opt.maxLen; i++) {
      for (j = 0; j < d; j++) {
        var freq = Math.pow(10000, -2 * Math.floor(j / 2) / d);
        this.pos[i][j] = (j % 2 === 0) ? Math.sin(i * freq) : Math.cos(i * freq);
      }
    }
  };

  function matmul(A, W) {
    var rows = A.length, cols = W[0].length, inner = W.length;
    var out = zeros2(rows, cols);
    for (var a = 0; a < rows; a++) {
      for (var c = 0; c < cols; c++) {
        var s = 0;
        for (var b = 0; b < inner; b++) s += A[a][b] * W[b][c];
        out[a][c] = s;
      }
    }
    return out;
  }

  TextEncoder.prototype.forward = function (ids) {
    var d = this.opt.dim, n = ids.length, i, j, k;
    var E = zeros2(n, d);
    for (i = 0; i < n; i++) {
      var pos = this.pos[Math.min(i, this.opt.maxLen - 1)];
      for (j = 0; j < d; j++) E[i][j] = this.emb[ids[i]][j] + 0.3 * pos[j];
    }

    var Q = matmul(E, this.Wq), K = matmul(E, this.Wk), V = matmul(E, this.Wv);
    var scale = 1 / Math.sqrt(d);
    var A = zeros2(n, n);
    for (i = 0; i < n; i++) {
      var row = new Array(n), mx = -Infinity;
      for (j = 0; j < n; j++) {
        var s = 0;
        for (k = 0; k < d; k++) s += Q[i][k] * K[j][k];
        row[j] = s * scale;
        if (row[j] > mx) mx = row[j];
      }
      var sum = 0;
      for (j = 0; j < n; j++) { row[j] = Math.exp(row[j] - mx); sum += row[j]; }
      for (j = 0; j < n; j++) A[i][j] = row[j] / sum;
    }

    var Z = zeros2(n, d);
    for (i = 0; i < n; i++) {
      for (k = 0; k < d; k++) {
        var s2 = 0;
        for (j = 0; j < n; j++) s2 += A[i][j] * V[j][k];
        Z[i][k] = s2;
      }
    }

    var R = zeros2(n, d);
    for (i = 0; i < n; i++) for (k = 0; k < d; k++) R[i][k] = Z[i][k] + E[i][k];

    var hbar = new Array(d).fill(0);
    for (i = 0; i < n; i++) for (k = 0; k < d; k++) hbar[k] += R[i][k] / n;

    var logit = this.b;
    for (k = 0; k < d; k++) logit += this.w[k] * hbar[k];

    /* Each token supplies exactly (w . R_i)/n of the logit - an exact additive
       decomposition, which is what the UI highlights. */
    var tokenContrib = new Array(n).fill(0);
    for (i = 0; i < n; i++) {
      var c = 0;
      for (k = 0; k < d; k++) c += this.w[k] * R[i][k];
      tokenContrib[i] = c / n;
    }

    return { E: E, Q: Q, K: K, V: V, A: A, R: R, hbar: hbar, logit: logit,
             p: sigmoid(logit), tokenContrib: tokenContrib, ids: ids };
  };

  TextEncoder.prototype.backward = function (fw, y, lr) {
    var d = this.opt.dim, n = fw.ids.length, i, j, k, p, q;
    var dlogit = fw.p - y;

    var dhbar = new Array(d);
    for (k = 0; k < d; k++) {
      dhbar[k] = dlogit * this.w[k];
      this.w[k] -= lr * (dlogit * fw.hbar[k] + 0.001 * this.w[k]);
    }
    this.b -= lr * dlogit;

    var dR = zeros2(n, d);
    for (i = 0; i < n; i++) for (k = 0; k < d; k++) dR[i][k] = dhbar[k] / n;

    var dE = zeros2(n, d);
    for (i = 0; i < n; i++) for (k = 0; k < d; k++) dE[i][k] += dR[i][k];

    var dV = zeros2(n, d), dA = zeros2(n, n);
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        var acc = 0;
        for (k = 0; k < d; k++) {
          dV[j][k] += fw.A[i][j] * dR[i][k];
          acc += dR[i][k] * fw.V[j][k];
        }
        dA[i][j] = acc;
      }
    }

    var dS = zeros2(n, n);
    for (i = 0; i < n; i++) {
      var dot = 0;
      for (j = 0; j < n; j++) dot += dA[i][j] * fw.A[i][j];
      for (j = 0; j < n; j++) dS[i][j] = fw.A[i][j] * (dA[i][j] - dot);
    }

    var scale = 1 / Math.sqrt(d);
    var dQ = zeros2(n, d), dK = zeros2(n, d);
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        var s = dS[i][j] * scale;
        for (k = 0; k < d; k++) {
          dQ[i][k] += s * fw.K[j][k];
          dK[j][k] += s * fw.Q[i][k];
        }
      }
    }

    function applyW(W, dOut) {
      var dW = zeros2(d, d), a;
      for (a = 0; a < n; a++)
        for (p = 0; p < d; p++)
          for (q = 0; q < d; q++) dW[p][q] += fw.E[a][p] * dOut[a][q];
      for (a = 0; a < n; a++) {
        for (p = 0; p < d; p++) {
          var acc2 = 0;
          for (q = 0; q < d; q++) acc2 += dOut[a][q] * W[p][q];
          dE[a][p] += acc2;
        }
      }
      for (p = 0; p < d; p++)
        for (q = 0; q < d; q++) W[p][q] -= lr * (dW[p][q] + 0.001 * W[p][q]);
    }

    applyW(this.Wq, dQ);
    applyW(this.Wk, dK);
    applyW(this.Wv, dV);

    for (i = 0; i < n; i++)
      for (k = 0; k < d; k++) this.emb[fw.ids[i]][k] -= lr * dE[i][k];
  };

  /* A 2341-parameter model on ~120 short documents will memorise the corpus,
     so a fifth of it is held out and never trained on. Both numbers are kept:
     the training AUC shows the block learned, the held-out AUC is the one
     worth quoting. */
  TextEncoder.prototype.fit = function (docs, labels) {
    this.buildVocab(docs);
    this.init();
    var self = this, i, j, t;
    var idsAll = docs.map(function (dd) { return self.ids(dd); });
    var rnd = mulberry32(this.opt.seed + 1);

    var shuffled = idsAll.map(function (_, k) { return k; });
    for (i = shuffled.length - 1; i > 0; i--) {
      j = Math.floor(rnd() * (i + 1));
      t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
    }
    var holdout = Math.max(0, Math.min(0.5, this.opt.holdout == null ? 0.2 : this.opt.holdout));
    var nTest = Math.round(shuffled.length * holdout);
    var testIdx = shuffled.slice(0, nTest);
    var order = shuffled.slice(nTest);
    this.lossCurve = [];

    for (var ep = 0; ep < this.opt.epochs; ep++) {
      for (i = order.length - 1; i > 0; i--) {
        j = Math.floor(rnd() * (i + 1));
        t = order[i]; order[i] = order[j]; order[j] = t;
      }
      var lr = this.opt.lr / (1 + ep * 0.02), loss = 0;
      for (var q = 0; q < order.length; q++) {
        var k = order[q];
        var fw = this.forward(idsAll[k]);
        loss -= labels[k] * Math.log(clamp(fw.p, 1e-9, 1)) + (1 - labels[k]) * Math.log(clamp(1 - fw.p, 1e-9, 1));
        this.backward(fw, labels[k], lr);
      }
      this.lossCurve.push(loss / order.length);
    }
    this.trained = true;

    this.trainAuc = rocAuc(order.map(function (k) { return labels[k]; }),
                           order.map(function (k) { return self.forward(idsAll[k]).p; }));
    this.testAuc = nTest > 4
      ? rocAuc(testIdx.map(function (k) { return labels[k]; }),
               testIdx.map(function (k) { return self.forward(idsAll[k]).p; }))
      : null;
    this.nTrain = order.length;
    this.nTest = nTest;
    this.nParams = this.vocabList.length * this.opt.dim + 3 * this.opt.dim * this.opt.dim + this.opt.dim + 1;
    return this;
  };

  /* Score free text: probability, which tokens pushed it, and how much
     attention mass each token received from the rest of the sequence. */
  TextEncoder.prototype.score = function (text) {
    if (!this.trained) return null;
    var toks = this.tokenize(text);
    if (!toks.length) return null;
    var ids = this.ids(text);
    var fw = this.forward(ids);
    var n = ids.length, attn = new Array(n).fill(0);
    for (var j = 0; j < n; j++) {
      for (var i = 0; i < n; i++) attn[j] += fw.A[i][j];
      attn[j] /= n;
    }
    var out = [];
    for (var k = 0; k < n; k++) {
      out.push({
        token: toks[k] || this.vocabList[ids[k]],
        known: ids[k] !== 0,
        contribution: fw.tokenContrib[k],
        attention: attn[k]
      });
    }
    return { p: fw.p, logit: fw.logit, tokens: out, vocabSize: this.vocabList.length };
  };

  /* --------------------------------------------------------------- exports */

  global.BRI = global.BRI || {};
  global.BRI.ML = {
    mulberry32: mulberry32, gauss: gauss, sigmoid: sigmoid, clamp: clamp,
    mean: mean, stdev: stdev,
    RandomForest: RandomForest,
    GradientBoosting: GradientBoosting,
    LogisticRegression: LogisticRegression,
    TextEncoder: TextEncoder,
    predictTree: predictTree, makeBinning: makeBinning,
    rocAuc: rocAuc, rocCurve: rocCurve, confusion: confusion,
    evaluate: evaluate, bestF1Threshold: bestF1Threshold, bestFBetaThreshold: bestFBetaThreshold,
    shapValues: shapValues, limeExplain: limeExplain,
    solveRidge: solveRidge, solveRidgeP: solveRidgeP
  };
})(typeof window !== 'undefined' ? window : globalThis);
