# What we need to move Business Analytics to your hosting

The application is built and working. To turn it into a live product with
business-owner accounts and an admin console, we need the items below.

Anything marked **blocking** stops us from starting that piece of work.
Everything else can follow while we build.

---

## 1 · Server access — blocking

We need to be able to deploy to the server and set it up.

1. **Control panel** — cPanel / Plesk URL, username and password.
   *Or*, if you prefer, **SSH**: host, port, username, and either a password or
   a public key we can add.
2. **What is installed on the server.** This decides the whole backend, so it
   is the first thing we need to know:
   - Node.js — and which version (`node -v`)
   - PHP — and which version
   - Anything else (Python, Docker)
3. **Database** — MySQL / MariaDB or PostgreSQL? Please create an empty
   database and send: host, port, database name, username, password.
4. **Where the app should live** — a domain or subdomain you want it on, for
   example `app.rebintech.com` or `risk.rebintech.com`, and confirmation that
   its DNS points at this server.
5. **SSL** — please confirm a certificate can be issued for that domain
   (Let's Encrypt is free and usually one click in cPanel).

   This one is not optional. Accounts and passwords must not travel over plain
   HTTP, and browsers now block parts of a login page that is not on HTTPS.

## 2 · Email — blocking for password reset

Account holders will forget passwords. Sending a reset link needs an outbound
mail route.

6. **SMTP details**: host, port, username, password, and whether it uses
   TLS/SSL. cPanel can create this on your own domain.
   *Or* an API key for SendGrid, Mailgun, Postmark or similar.
7. **The "from" address** the emails should come from, for example
   `noreply@rebintech.com`, and a reply-to address if it should differ.

## 3 · Decisions only you can make

These change how the system behaves, so we need your answer rather than a
guess.

8. **Where does uploaded data live?** This is the most important question on
   this list.

   - **Option A — data stays in the browser.** Files are scored on the
     customer's own machine and never reach the server. Only usage counts are
     recorded (who ran a scan, how many rows, how many flagged). Strongest
     privacy position, and the easiest to explain to a bank or an auditor.
   - **Option B — data is stored on the server.** Customers can reopen past
     scans, and the admin console can show the actual transactions. More
     useful, but you are then holding other companies' payment data, which
     brings real obligations.

   We recommend **Option A** unless a customer has specifically asked to have
   their history stored.

9. **Who can open an account?** Open sign-up for anyone, sign-up with email
   verification, or invite-only where you create the accounts?
10. **Who gets admin access** to the console — please list the email
    addresses.
11. **Any usage limits** per account (maximum rows per upload, scans per
    month)? Send "no limits" if there are none.

## 4 · Branding

12. **Logo** — SVG preferred, otherwise PNG with a transparent background.
13. **Brand colours** — hex codes if you have them.
14. **The product name to display.** It currently reads *Business Analytics*.
    Tell us if it should carry your name or the end client's instead.
15. **Footer details** — company legal name, support email, and links to your
    site if you want them.

## 5 · Sample data — important for accuracy

16. **One real transaction export**, with names and card numbers removed or
    scrambled. Twenty rows is enough.

    The reason this matters: the system reads whatever column names your file
    uses and maps them automatically. It currently handles common formats, but
    every bank and payment processor names its columns differently. One real
    export lets us tune it to the files your customers will actually upload,
    instead of guessing.

17. **One real company financials export**, same thing — anonymised, a handful
    of rows.

## 6 · Legal

18. **Privacy policy and terms of service** text, or confirmation that we
    should draft a standard version for your lawyer to review.
19. **Which country's rules apply** — this affects how long data may be kept
    and what the privacy policy has to say.

---

## What happens once we have these

| Stage | Needs | Working days |
|---|---|---|
| Backend: accounts, sessions, password reset | items 1–7, 9, 10 | 3–4 |
| Admin console with live usage data | items 8, 11 | 2–3 |
| Branding applied | items 12–15 | 1 |
| Column mapping tuned to your real files | items 16–17 | 1 |
| Deploy, SSL, testing | item 1, 5 | 1 |

Items 1 to 7 are the ones that unblock everything else. If it is easier, send
those first and the rest can follow.

---

## What already works today

So it is clear what is being added rather than built from scratch:

- Fraud transaction scanner — CSV upload, automatic column mapping, risk
  scoring, risk distribution, and an investigation queue ordered by expected
  loss
- Business financial health score — manual entry or bulk CSV, a score out of
  100, failure probability, the drivers behind it, and recommendations
- The models themselves — Random Forest, gradient-boosted trees, logistic
  regression, SHAP and LIME explanations, and a transformer encoder for
  narrative text, all running live
- Research methodology section with held-out evaluation metrics and an audit
  log of every model run
- Light and dark themes

The sign-in screen and admin console are built and can be demonstrated now.
They currently run in demo mode, which keeps accounts in the browser only —
that is what the server work above replaces.
