# Business Analytics — Auth API

The server-side replacement for `assets/auth.js`, which kept accounts in
`localStorage` and therefore enforced nothing: every check ran on the client,
so anyone could edit storage and grant themselves an admin role. These checks
run on the server, and the client is never trusted about who it is.

**Scope: authentication and accounts only.**

## What this server deliberately does not do

It does not score anything. The Random Forest, gradient-boosted trees and the
rest stay in the browser (`assets/ml.js`), and customer transaction CSVs are
never uploaded. That is a deliberate architectural decision, not an omission:

- Cardholder data never crosses the network or touches a disk we operate,
  which keeps the product out of **PCI DSS scope**.
- There is no breach surface for customer transaction data here, because the
  data is not here.

Adding a scoring endpoint would reverse both of those properties. Do not add
one without a decision that accounts for the compliance consequences.

---

## Running locally

Zero setup: the default configuration uses SQLite and creates the database file
on first run.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env               # optional for local work

uvicorn app.main:app --reload
```

- API: `http://127.0.0.1:8000`
- Interactive docs: `http://127.0.0.1:8000/docs`
- Health: `http://127.0.0.1:8000/health`

With `ENVIRONMENT=development` and an empty `SECRET_KEY`, a random key is
generated per process, so nothing needs configuring. Restarting the server
invalidates the tokens it had issued — expected locally, unacceptable in
production, which is why production refuses to start without a real key.

### Tests

```bash
cd backend
pytest
```

Tests run against in-memory SQLite and never touch your development database.

---

## Generating the secret

```bash
openssl rand -hex 32
```

Put the result in `SECRET_KEY`. It signs and verifies every JWT, so anyone
holding it can mint a token for any account, including an admin one.

- Generate a **different** key per environment.
- Never commit it. `.env` is for it; `.env.example` deliberately ships blank.
- Rotating it signs every user out immediately, which is the correct response
  to a suspected leak.

In production, startup **fails loudly** if `SECRET_KEY` is missing or shorter
than 32 characters, and if `DATABASE_URL` still points at SQLite.

---

## Switching to PostgreSQL

Change one variable. No code edit:

```bash
DATABASE_URL=postgresql+psycopg://sentinel:yourpassword@localhost:5432/sentinel
```

The UUID primary keys become native `uuid`, and `meta` becomes `jsonb`,
automatically — see the type variants in `app/models.py`.

## Deploying with Docker

```bash
cd backend
cp .env.example .env
# set SECRET_KEY and POSTGRES_PASSWORD, and ENVIRONMENT=production
docker compose up --build
```

Compose refuses to start if `SECRET_KEY` or `POSTGRES_PASSWORD` is unset,
rather than defaulting to something blank.

For any other host (Railway, Fly.io, Render, ECS): build the `Dockerfile`, set
the same environment variables, and point `DATABASE_URL` at the managed
Postgres instance. Terminate TLS at the platform's load balancer — the app
speaks plain HTTP behind it, and tokens must never cross the public internet
unencrypted.

**Run one worker per container** until the rate limiter moves to Redis. Its
counters live in process memory, so N workers enforce N times the configured
limit. Scale with more containers only after that change.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness probe |
| POST | `/auth/register` | — | Create an account, signed in on success |
| POST | `/auth/login` | — | Exchange credentials for tokens |
| POST | `/auth/refresh` | — (refresh token in body) | New token pair |
| POST | `/auth/logout` | Bearer | Record the sign-out |
| GET | `/auth/me` | Bearer | The signed-in user's profile |
| POST | `/events` | Bearer | Record one usage event for the caller |
| GET | `/events` | Bearer | Usage events the caller may see |
| GET | `/admin/users` | Bearer (admin) | Every account, with usage aggregates |
| PATCH | `/admin/users/{id}` | Bearer (admin) | Enable or disable an account |

`register`, `login` and `refresh` all return the same body: an access token, a
refresh token, `expires_in`, and the user profile — so the client never needs a
second round trip to render a signed-in header.

Authenticated requests use `Authorization: Bearer <access_token>`.

---

## Usage tracking and the admin console

`POST /events` records one event for **the account in the bearer token**. There
is no `user_id` field in the body and an attempt to send one is a 422, not a
silently ignored field — the demo provider's `userIdOverride` was harmless when
every account lived in one browser and is a forgery primitive the moment
accounts are shared.

```jsonc
POST /events        {"type": "scan", "meta": {"rows": 1200, "file": "march.csv"}}
```

- `type` must be one of `login`, `signup`, `logout`, `scan`, `health`,
  `portfolio`, `export`, `retrain`, `admin_toggle_user`. The allowlist is
  closed: it reaches an indexed column the console groups on, so an open field
  would let any caller invent categories the console then renders.
- `meta` is capped at **4 KiB of serialised JSON**, so usage tracking cannot be
  used as free storage. Both limits live in `app/schemas.py`.

`GET /events` takes `type`, `user_id`, `since` (ISO timestamp) and `limit`
(default 500, max 2000), and returns newest first.

> **A customer only ever receives their own events.** `user_id` from a customer
> is a filter, never a grant — it is *overruled*, not merely ignored, and the
> scope is pinned to the caller's own id before any parameter is read. An admin
> may filter by `user_id` or omit it and see everyone. This is enforced in
> `list_events` and asserted directly in `tests/test_events.py`.

`GET /admin/users` returns every account with its aggregates — `scans`,
`healths` and `rows` — computed by **one grouped SQL query with a LEFT JOIN**,
not by shipping the event table to the browser. The console previously walked
every event once per row it drew, which is fine for a seeded demo and quadratic
against real history.

`PATCH /admin/users/{id}` takes `{"active": bool}` and **refuses to disable an
administrator** with 409 and `auth.js`'s own sentence, *"An administrator
account cannot be disabled here."* That rule is not ceremony: no endpoint can
grant the admin role back, so disabling the last admin would lock everyone out
of the console with no in-product way to recover. Each toggle is itself
recorded as an `admin_toggle_user` event.

### Response field names — read this before changing either side

The frontend reads **camelCase** (`u.createdAt`, `u.lastLoginAt`, `u.loginCount`,
`u.seeded`, `e.ts`, `e.meta`, `e.userId`, `e.type`) and the Python side is
snake_case. The bridge is **serialisation aliases on the response models**
(`app/schemas.py`), so the wire format is exactly what `admin.js` already
expects and no frontend change is required. The ORM, the queries and the tests
stay idiomatic Python.

Timestamps are serialised as **epoch milliseconds, as integers** — not ISO
strings. `admin.js` does arithmetic on them (`now - u.lastLoginAt`,
`(e.ts - first) / dayMs`, `(b.lastLoginAt || 0) - (a.lastLoginAt || 0)`), which
only works on numbers. An ISO string would survive `new Date(...)` and then
produce `NaN` in every one of those expressions — a silent wrong answer rather
than a visible failure. `tests/test_events.py` asserts both the key names and
the integer type, so this cannot regress unnoticed.

`seeded` is always `false`. It marked the demo provider's generated sample
accounts; nothing created through this API is sample data, but the field is
still emitted because `admin.js` reads it unconditionally to render a "sample"
chip.

---

## Promoting an administrator

**No endpoint can set a role.** `role` is not a field on the register schema;
sending it returns 422 rather than being silently ignored. Every account
created through the API is a `customer`.

Promotion is a deliberate out-of-band database operation:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

The supported way to run it is the bundled script, which reads the same
`DATABASE_URL` as the application — so it cannot promote an account in a local
SQLite file while the app is talking to Postgres, which is the mistake raw SQL
invites:

```bash
cd backend
.venv/Scripts/python.exe scripts/promote_admin.py you@example.com   # Windows
.venv/bin/python scripts/promote_admin.py you@example.com           # macOS/Linux

# and to demote
.venv/bin/python scripts/promote_admin.py them@example.com --role customer
```

It normalises the address the same way the API does, is idempotent, and exits
non-zero if no such account exists.

The equivalent by hand, if you would rather go straight to the database:

```bash
# PostgreSQL
psql "$DATABASE_URL" -c "UPDATE users SET role='admin' WHERE email='you@example.com';"

# SQLite (local)
sqlite3 sentinel.db "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

The user must obtain a new access token (sign out and back in, or refresh) for
the change to appear in their token. Authorisation itself re-reads the role
from the database on every request, so a token minted before a **demotion**
stops working immediately rather than lasting until it expires.

---

## Security decisions worth knowing

- **bcrypt, cost 12** (`passlib`). Never a bare hash. Passwords are never
  logged and never appear in any response.
- **Login cannot enumerate accounts.** Unknown email and wrong password return
  a byte-identical 401, and the unknown-email path performs a dummy bcrypt
  verification so response *timing* does not leak the answer either.
- **"Account disabled" is reported only after the password verifies.** Telling
  an unauthenticated caller that an account is disabled would confirm it
  exists.
- **Disabled accounts are rejected on every request**, not just at login, so
  disabling takes effect immediately.
- **Refresh tokens cannot be used as access tokens.** Both carry the same
  signature; an explicit `type` claim separates them.
- **Registration rules mirror `auth.js` exactly** — minimum 8 characters, the
  same common-password list, and the same rejection of a password containing an
  email local part of 4+ characters — using the same user-facing messages, so
  the frontend reads identically against either provider.
- **CORS is an explicit origin list.** Credentials are enabled, which the CORS
  spec makes mutually exclusive with `*`.

### bcrypt is pinned to 4.0.1 on purpose

`passlib` 1.7.4 probes its bcrypt backend at import using a secret longer than
72 bytes. bcrypt ≥ 4.1 raises `ValueError` on that instead of truncating, so
passlib cannot initialise at all and every password operation fails. Unpin only
when passlib 1.7.5+ ships the fix.

---

## Not yet implemented

An explicit list, so none of this is mistaken for done:

**Usage tracking and the admin console are now implemented** — `POST /events`,
`GET /events`, `GET /admin/users` and `PATCH /admin/users/{id}` are live and
documented above. What remains from that phase:
- **An admin endpoint for promotion.** Still deliberately absent; use
  `scripts/promote_admin.py`. An endpoint that can grant the admin role is a
  privilege-escalation surface, and nothing in the product currently needs one.
- **Event retention.** Rows accumulate indefinitely. A real deployment needs a
  retention window and a job to enforce it, which is also a GDPR question, not
  only a disk one.
- **Pagination beyond a limit.** `GET /events` caps at 2000 rows with no cursor,
  which is sufficient for the console today and not for a full export.

**Security work required before a real production launch:**
- **Token revocation.** Tokens are stateless, so `logout` records the event but
  cannot invalidate an already-issued access token; it stays valid until it
  expires (30 minutes by default). A leaked refresh token likewise stays valid
  for its full lifetime. Needs a `jti` deny-list in Redis — the claim is
  already minted into every token for this purpose.
- **Distributed rate limiting.** In-memory today; must move to Redis before
  running more than one worker or replica.
- **Rate limiting on `/auth/register`** — currently only login is limited.
- **Password reset and email verification.** No flow exists, and addresses are
  currently unverified.
- **Account lockout** after sustained failures, distinct from rate limiting.
- **Refresh token rotation with reuse detection**, which is what turns a stolen
  refresh token into a detectable event.
- **Multi-factor authentication.**

**Operational:**
- **Alembic migrations.** `init_db()` runs `create_all`, which creates missing
  tables but never alters an existing one. Any column change after the first
  production deploy needs real migrations.
- **Structured logging, audit trail and error monitoring.**
- **Refresh tokens are returned in the response body**, so the browser stores
  them in JavaScript-reachable storage and an XSS becomes a session
  compromise. A `Secure`, `HttpOnly`, `SameSite` cookie is the stronger
  arrangement.

---

## Project layout

```
backend/
├── app/
│   ├── main.py            FastAPI app, CORS, /health, router registration
│   ├── config.py          Settings from environment + fail-loud production checks
│   ├── database.py        Engine, session dependency, init_db
│   ├── models.py          User, UsageEvent (+ cross-dialect UUID/JSON types)
│   ├── schemas.py         Request/response models, password rules, messages
│   ├── security.py        bcrypt, JWTs, rate limiter, auth dependencies
│   └── routers/
│       ├── auth.py        register, login, refresh, logout, me
│       └── events.py      POST/GET /events, /admin/users (list + set active)
├── scripts/
│   └── promote_admin.py   Out-of-band role change; no endpoint can set a role
├── tests/
│   ├── conftest.py        Isolated in-memory DB per test
│   ├── test_auth.py
│   └── test_events.py
├── requirements.txt
├── .env.example
├── Dockerfile
└── docker-compose.yml
```

## Connecting the frontend

`assets/auth.js` is written around a swappable provider — `PROVIDER` at the top
selects it, and `app.js` calls nothing but the documented methods. Implement a
provider that calls these endpoints, keeping `signUp`, `signIn`, `signOut` and
`currentUser` with their existing signatures. Because the error messages here
are identical to the demo provider's, the sign-in form needs no changes.

`listUsers`, `setActive`, `track` and `events` now have endpoints too, and the
`apiProvider` at the bottom of `auth.js` already calls them at the paths and
query parameters documented above. The response bodies use the camelCase keys
and millisecond timestamps `admin.js` already reads, so switching `PROVIDER` to
`'api'` and setting `API_BASE` is the whole change — no edit to `app.js` or
`admin.js` is required.

One behavioural difference worth knowing: the demo provider's `setActive` threw
a plain `Error` for an admin account, while the API returns 409 with the same
sentence in `detail`. `apiCall` turns that into an `Error` carrying that text,
so the console renders it identically.
