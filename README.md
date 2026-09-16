# Sentinel Risk Desk

An AI-powered business risk and intelligence platform. One web app, three
working sections: a fraud transaction scanner, a business financial health
score, and the research methodology that connects them.

Everything runs in the browser. There is no server and no account to create —
open `index.html` and the platform is live.

**Hosted demo:** https://claude.ai/artifact/Qtcugw6h2nWdAuNb2D3btA

---

## What it does

### Section 1 — Fraud detection / transaction scanner

Upload a transaction CSV. The platform reads the headers, maps them to the
fields it needs, derives twelve behavioural features and scores every row
through the trained ensemble.

- **Input** — any transaction CSV. Column mapping is automatic and fully
  overridable; only *amount* is strictly required, and everything else
  degrades gracefully with documented imputation.
- **Results** — total transactions, high/medium risk counts, average risk
  score, value at risk (exposure), risk distribution and flagged transactions.
- **Views** — Dataset Preview, Scored Output, Investigation Queue.
- **Export** — scored output or the investigation queue, as CSV.

### Section 2 — Business financial health score

Type the figures in, or upload a financials CSV and score a whole portfolio.

- **Manual input** — annual revenue, net profit, total assets, total
  liabilities, cash reserve, revenue growth, plus current assets, current
  liabilities and interest expense.
- **CSV option** — the same fields as columns, with the same mapping step.
- **Main output** — Business Health Score out of 100.
- **Supporting output** — profitability, liquidity, solvency and
  growth pillars, a model failure probability, key drivers, a written risk
  interpretation and prioritised recommendations.

### Section 3 — Research methodology and real-world implementation

The seven methods the platform is built on (01–07), each stated alongside the
live evidence that it ran: real hyperparameters, real held-out metrics, and a
run log of every training and scoring job the session has executed.

---

## The models are real

The brief was explicit that Random Forest and XGBoost must not be page text.
They are not. Both are implemented from scratch in `assets/ml.js` and execute
in the browser every time the platform scores:

| Method | Where it lives | What is genuinely implemented |
|---|---|---|
| Random Forest | `ml.js` → `RandomForest` | Bootstrap resampling, `sqrt(d)` feature subsampling per split, exact sorted-scan Gini search, out-of-bag AUC on the samples each tree never saw |
| Gradient-boosted trees | `ml.js` → `GradientBoosting` | The XGBoost objective — second-order gradients and hessians of the logistic loss, structure-score split gain `½[G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ)] − γ`, leaf weight `−G/(H+λ)`, shrinkage, row subsampling, column subsampling |
| Logistic regression | `ml.js` → `LogisticRegression` | Standardised features, L2 penalty, batch gradient descent with a decaying step; standardised coefficients and odds ratios are the interpretable baseline |
| Transformer NLP | `ml.js` → `TextEncoder` | One encoder block: learned embeddings, sinusoidal positions, single-head scaled dot-product self-attention, residual connection, mean pooling, linear head — trained by hand-written backpropagation through the softmax |
| SHAP | `ml.js` → `shapValues` | Permutation-sampled Shapley values over a background set, satisfying local accuracy |
| LIME | `ml.js` → `limeExplain` | Proximity-weighted neighbourhood sampling with a ridge-regression local surrogate, reported with its local R² |
| Evaluation | `ml.js` → `evaluate` | ROC-AUC (rank-based, tie-corrected), precision, recall, F1, accuracy, specificity, confusion matrix, F1-optimal operating threshold |

The **Run Log** in Section 3 is the system record for this: every fit and every
scoring batch is written to it with a timestamp, the hyperparameters used, row
counts, resulting metrics and wall-clock latency. It exports as JSON.

Retraining is exposed in the UI. Change the tree count, depth, learning rate or
boosting rounds and the models refit in front of you — the metrics, the ROC
curves and the confusion matrix all move, because they are computed, not
written down.

---

## Data

The platform ships with a documented synthetic generator (`assets/data.js`)
rather than a scraped dataset, so it can be published and shared without any
privacy exposure.

Both generators build **interaction effects**, not linear scores. Fraud risk
rises when card-not-present *and* cross-border occur together; leverage only
becomes dangerous when the cash runway is *also* short. That structure is why
the tree ensembles outperform the logistic baseline in the evaluation table —
the gap is earned on the held-out split, not asserted.

Sample CSVs in `samples/` exercise the upload path end to end, including
deliberately awkward header names, so the column mapper has something real to
solve.

---

## Project structure

```
Business_Analytics/
├── index.html                  Entry point — all three sections
├── build.js                    Produces the hosted variant (see Deploying)
├── README.md                   This file
├── assets/
│   ├── ml.js                   Models, explainers, evaluation
│   ├── data.js                 Generators, CSV I/O, column mapping, features
│   ├── app.js                  UI, charts, scoring pipeline, run log
│   └── app.css                 Design system, light and dark
├── samples/
│   ├── transactions_sample.csv   900 rows, awkward headers, 3.2% labelled fraud
│   └── financials_sample.csv     220 companies
├── docs/
│   └── methodology.md          The 01–07 methodology in long form
└── dist/
    └── artifact.html           Generated by `node build.js`; not tracked in git
```

## Running it

Open `index.html` in any modern browser. Nothing to install.

To serve it over HTTP instead (useful for loading it on another device on the
same network):

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Deploying

Everything is static, so any static host works — Netlify, Vercel, GitHub Pages,
Cloudflare Pages, or plain nginx. Upload `index.html`, `assets/` and
`samples/`; there is no build command and no environment configuration.

Some hosts supply their own `<!doctype>`/`<head>`/`<body>` wrapper and expect
only the page content. For those, run:

```bash
node build.js
```

which writes `dist/artifact.html` — the same page with the document wrapper
stripped, still pointing at `assets/` by the same relative paths. Re-run it
after any edit to `index.html`.

## Verifying the models yourself

The claims in Section 3 are checkable. In a browser console on the running
page:

```js
// Refit and print held-out metrics for every model
BRI.ML.rocAuc(yTest, scores)          // any label/score pair
BRI.ML.evaluate(yTest, scores, 0.12)  // full confusion matrix at a threshold
```

Or drive the models directly in Node, which is how they were validated during
development:

```js
const fs = require('fs');
eval(fs.readFileSync('assets/ml.js', 'utf8'));
eval(fs.readFileSync('assets/data.js', 'utf8'));
const { ML, Data } = globalThis.BRI;
// Data.generateTransactions(n, seed) / Data.generateCompanies(n, seed)
// then fit ML.RandomForest, ML.GradientBoosting, ML.LogisticRegression
```

The additive decompositions are exact and worth checking: for any case,
`pathContributions(x).bias + Σ contributions` reproduces the model output to
about 1e−16.
