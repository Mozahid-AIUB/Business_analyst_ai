# Research methodology and implementation

Long-form reference for the seven methods behind Sentinel Risk Desk. Section 3
of the application shows the same material with live figures attached; this
document explains the reasoning and points at the code.

Every method below is implemented in [`../assets/ml.js`](../assets/ml.js) and
runs in the browser. Nothing here is a description of something done
elsewhere.

---

## 01 · Random Forest

**Implementation:** `RandomForest` — `ml.js`

Each tree is grown on a bootstrap resample of the training rows and may
consider only a random `sqrt(d)` subset of the features at every split. Two
sources of randomness, so the trees make different mistakes; averaging their
votes cancels most of the variance a single deep tree would carry.

Splits maximise the weighted Gini impurity decrease. Impurity for a binary
target is `2p(1−p)`, and a split is scored as

```
gain = n·2p(1−p) − [ n_L·2p_L(1−p_L) + n_R·2p_R(1−p_R) ]
```

The search runs over a quantile-binned grid (see *Histogram splitting* below)
rather than over raw values.

**Why it suits risk work.** A tree partitions the feature space instead of
fitting a surface through it. A rule like *card-not-present **and**
cross-border **and** amount well above this account's own norm* is three
nested splits — a conjunction the model represents exactly. A linear model can
only add those effects up, which is why it systematically under-prices the
combinations that actually matter.

**Out-of-bag scoring.** Roughly a third of rows are left out of each bootstrap.
Averaging only the trees that never saw a given row gives an honest error
estimate before the test split is touched. The OOB AUC reported in the
application runs lower than the test AUC, and that is expected rather than a
defect: each OOB prediction averages about a third as many trees, so it carries
correspondingly more variance. The gap is a direct measurement of how much the
forest gains from its own size.

---

## 02 · XGBoost / gradient-boosted trees

**Implementation:** `GradientBoosting` — `ml.js`

Where the forest averages independent trees, boosting grows them in sequence:
each new tree is fitted to what the ensemble still gets wrong.

This uses the XGBoost objective directly. Each round computes the first and
second derivatives of the logistic loss per row,

```
g = p − y            h = p(1 − p)
```

and a split is taken only when it improves the regularised structure score:

```
gain = ½ [ G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ) ] − γ
```

Each leaf takes the weight that minimises the second-order approximation:

```
w = −G / (H + λ)
```

Shrinkage (`eta`), row subsampling and column subsampling keep the sequence
from memorising the training set, and `min_child_weight` refuses splits whose
children carry too little hessian mass — the correct guard when positives are
rare, since a leaf of five positive rows has almost no hessian behind it.

**Why it usually wins.** Later trees specialise in the hard region near the
decision boundary. That region is exactly where a fraud queue lives.

---

## Histogram splitting

**Implementation:** `makeBinning`, `binIndex` — `ml.js`

Both learners quantise each feature once into at most 32 quantile buckets.
Split search then accumulates counts (or gradient/hessian sums) into that fixed
grid instead of re-sorting rows at every node, turning the per-node cost from
`O(n log n)` per feature into `O(n + bins)`.

This is the same trick as XGBoost's `tree_method=hist`. On the reference
datasets it cut total fit time from roughly 4.5 seconds to under 0.6 — the
difference between a platform that stalls on load and one that does not. Trees
still store real-valued thresholds, so prediction is unchanged.

---

## 03 · Logistic regression

**Implementation:** `LogisticRegression` — `ml.js`

Standardised features, an L2 penalty, batch gradient descent with a decaying
step. Probability is a single weighted sum, so every coefficient is an odds
ratio a credit committee or a regulator can read straight off the page.

It is kept for two reasons, and neither is decoration:

1. **It is the control.** If the ensembles cannot beat a straight line on
   held-out data, their complexity is not paying for itself and should be
   removed.
2. **The gap is a measurement.** When the ensembles do win, the size of the AUC
   gap quantifies how much of the risk lives in interactions rather than in
   main effects. On the reference fraud data that gap is about 0.06 AUC.

---

## 04 · Transformer-based NLP

**Implementation:** `TextEncoder` — `ml.js`

Financial distress is often written down before it reaches a ratio. Covenant
waivers, going-concern language and stretched supplier terms appear in board
packs and audit letters quarters ahead of the balance sheet.

One encoder block turns that text into a number:

```
tokens → learned embeddings + sinusoidal positions
       → Q, K, V projections
       → A = softmax(QKᵀ / √d)
       → Z = A·V
       → R = Z + E            (residual)
       → mean pool → linear head → probability
```

Trained by hand-written backpropagation through the softmax — the gradient
`dS = A ⊙ (dA − (dA·A))` and the three weight matrices are all in
`TextEncoder.backward`.

**Why attention rather than a keyword list.** The training corpus deliberately
contains negated pairs built from the *same content words*:

| Text | Label |
|---|---|
| "no covenant waiver was required this period" | healthy |
| "the covenant waiver was not granted by lenders" | distress |
| "the auditor raised no going concern doubt" | healthy |
| "margin expansion did not materialise" | distress |

A model that scores tokens independently cannot separate these. The trained
encoder classifies all four correctly, which is the evidence that the attention
layer is doing real work rather than counting words.

**Honest reporting.** A ~2,700-parameter model on ~160 short documents will
memorise its corpus, so a fifth is held out and never trained on. The
application reports both the training AUC (1.000 — it memorised, as expected)
and the held-out AUC (~0.90), and the held-out figure is the one worth quoting.

**Attribution is exact.** Because pooling is a mean, each token supplies
precisely `(w · R_i)/n` of the final logit. The token highlighting in Section 2
is therefore an exact decomposition, not a heat-map impression.

---

## 05 · SHAP and LIME

**Implementation:** `shapValues`, `limeExplain`, `pathContributions` — `ml.js`

These answer different questions and the platform uses all three.

**SHAP — what did each feature contribute to *this* prediction?** Features are
revealed in random order over a background sample; the marginal change each
reveal causes is averaged across permutations. That is the Shapley value from
cooperative game theory. It satisfies local accuracy — base rate plus
contributions reconstructs the model output — and the application prints both
sides of that identity so the sampling error is visible rather than hidden.

**LIME — what does the model look like *around* this case?** Sample a
neighbourhood, weight each sample by proximity, fit a ridge regression to the
model's responses.

Two details matter and both were fixed during implementation:

- The surrogate needs an **unpenalised intercept**. Without one it is forced
  through the origin and its R² goes negative — the first version of this code
  reported −2.39, which is worse than predicting a constant.
- The neighbourhood must be **genuinely local**. Perturbing by a full feature
  standard deviation samples most of the data space, where a tree ensemble is
  nowhere near linear. At 0.35 SD with a tightened kernel, median local R²
  across flagged cases is about 0.58.

The local R² is reported next to every LIME explanation, because a surrogate
that fits badly is a surrogate that should not be quoted.

**Path contributions — the bulk method.** Walking each tree and attributing
every change in node value to the feature that caused it gives an exact
additive decomposition: `bias + Σ contributions` reproduces the model output to
floating-point precision (measured error ~1e−16). It costs about one pass down
each tree, cheap enough to run on every row of an uploaded file, which is why
the investigation queue can name a reason for each flag.

---

## 06 · Model evaluation

**Implementation:** `evaluate`, `rocAuc`, `rocCurve`, `bestF1Threshold` — `ml.js`

Every reported number is computed on a held-out 30% split that no model saw
during fitting. ROC-AUC is rank-based with tie correction (the Mann–Whitney
identity); precision, recall, F1, accuracy and specificity are read off the
confusion matrix at a stated threshold.

**On hyperparameters.** They are fixed conservative defaults — shallow trees, a
low learning rate, a real L2 penalty — chosen because that is what a rare
positive class asks for. They were deliberately *not* selected by scoring the
test split. Doing that is the most common way a portfolio model ends up
reporting a number it cannot reproduce, because the test set has quietly leaked
into every choice. The sliders in the application let a reviewer tune them and
watch the metrics move.

**On the threshold.** The deployed cut-off maximises F1 on the evaluation
split, not 0.5. At a base rate near 4%, a 0.5 threshold produces a model that
looks 96% accurate and catches almost nothing — the single most common way a
fraud model passes review and fails in production.

---

## 07 · Prediction to business action

A probability is not a decision.

**In the scanner**, the score becomes a queue ordered by **expected loss**
(amount × probability), because a 0.9 on a small ticket should not outrank a
0.6 on a large one. Each case carries the features that drove it, a SHAP and a
LIME view, and a recommended disposition.

**In the health score**, the same machinery produces a score out of 100, a
written interpretation, and recommendations that carry the figure closing each
gap — the debt to retire to reach 50% leverage, the reserve to build to reach a
six-month runway, the margin points to recover.

**The run log** is the audit trail. Every fit and every scoring batch is
recorded with hyperparameters, row counts, metrics and wall-clock latency, and
exports as JSON.

---

## The reference data

Both generators are documented processes in
[`../assets/data.js`](../assets/data.js), not scraped datasets, so the platform
can be published and shared with no privacy exposure.

They are built around **conjunctions**, not weighted sums, and two of the
patterns are **non-monotone** — which is the whole reason the tree/linear
comparison is meaningful rather than rigged:

| Pattern | Conditions | Why linear models miss it |
|---|---|---|
| Card testing | tiny amount **and** high velocity **and** remote channel | Risk rises as amount *falls* — the opposite sign to every other fraud pattern |
| Account takeover | new device **and** cross-border **and** spend above the account's norm | None of the three is dangerous alone |
| Bust-out | account age *between* 50 and 220 days **and** elevated spend **and** a barely-existing merchant | Risk peaks in a window of tenure, not above a cut-off |
| Mule transfer | wire **and** cross-border **and** large | Pure three-way conjunction |
| Overtrading | growth above 28% **and** short runway **and** thin margin | Risk rises at *both* ends of growth; a line must pick one sign |
| Leverage squeeze | leverage above 62% **and** runway under 3.2 months | Leverage alone is not the signal |

Main effects are deliberately small, the conjunction weights large. The AUC gap
the leaderboard reports is produced by that structure.
