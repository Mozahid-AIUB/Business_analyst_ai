# Sentinel Risk Desk — Auth API

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

`register`, `login` and `refresh` all return the same body: an access token, a
refresh token, `expires_in`, and the user profile — so the client never needs a
second round trip to render a signed-in header.

Authenticated requests use `Authorization: Bearer <access_token>`.

---

## Promoting an administrator

**No endpoint can set a role.** `role` is not a field on the register schema;
sending it returns 422 rather than being silently ignored. Every account
created through the API is a `customer`.

Promotion is a deliberate out-of-band database operation:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

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

**Deferred to the usage-tracking / admin phase (schema is ready):**
- `GET /usage/events` and `POST /usage/track` — the `usage_events` table and
  its indexes exist, and `signup`/`login`/`logout` rows are already being
  written, but nothing reads them back yet.
- `GET /admin/users` — the `listUsers` equivalent.
- `PATCH /admin/users/{id}/active` — the `setActive` equivalent, including
  `auth.js`'s rule that an admin account cannot be disabled this way.
- An admin endpoint for promotion, replacing the manual SQL above.

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
│       └── auth.py        register, login, refresh, logout, me
├── tests/
│   ├── conftest.py        Isolated in-memory DB per test
│   └── test_auth.py
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

`listUsers`, `setActive`, `track` and `events` have no endpoints yet; see
"Not yet implemented".
