"""Auth endpoint tests.

Each test gets a fresh in-memory SQLite database via the fixtures in
conftest.py, so ordering never matters and nothing leaks between cases.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import User
from app.schemas import (
    MSG_BAD_CREDENTIALS,
    MSG_COMMON_PASSWORD,
    MSG_DISABLED,
    MSG_DUPLICATE_EMAIL,
    MSG_EMAIL_IN_PASSWORD,
    MSG_SHORT_PASSWORD,
)

GOOD_PASSWORD = "tr0ubador-stapler"


REFRESH_COOKIE = "sentinel_refresh"


def refresh_cookie(response) -> str:
    """The refresh token is an HttpOnly cookie now, not a body field, so tests
    read it the way a browser would."""
    return response.cookies.get(REFRESH_COOKIE, "")


def register(client: TestClient, email: str = "ana@northgate.com", password: str = GOOD_PASSWORD, **kw):
    body = {"email": email, "password": password}
    body.update(kw)
    return client.post("/auth/register", json=body)


def login(client: TestClient, email: str = "ana@northgate.com", password: str = GOOD_PASSWORD):
    return client.post("/auth/login", json={"email": email, "password": password})


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------- register

def test_register_returns_tokens_and_profile(client: TestClient) -> None:
    r = register(client, name="Ana Silva", company="Northgate Trading")
    assert r.status_code == 201, r.text
    body = r.json()

    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert REFRESH_COOKIE in r.cookies
    assert body["expires_in"] == 30 * 60

    user = body["user"]
    assert user["email"] == "ana@northgate.com"
    assert user["name"] == "Ana Silva"
    assert user["company"] == "Northgate Trading"
    assert user["role"] == "customer"
    assert user["active"] is True
    assert user["login_count"] == 1


def test_register_never_returns_password_fields(client: TestClient) -> None:
    """The whole response body is searched, not just the user object: a hash
    leaking anywhere in the payload is the failure worth catching."""
    r = register(client)
    assert r.status_code == 201
    assert "hashed_password" not in r.text
    assert "password" not in r.json()["user"]
    assert GOOD_PASSWORD not in r.text


def test_register_defaults_name_and_company_like_auth_js(client: TestClient) -> None:
    r = register(client, email="solo@ironwood.co")
    assert r.status_code == 201
    user = r.json()["user"]
    assert user["name"] == "solo"
    assert user["company"] == "—"


def test_register_lowercases_email(client: TestClient) -> None:
    r = register(client, email="  MiXeD@Case.COM  ")
    assert r.status_code == 201
    assert r.json()["user"]["email"] == "mixed@case.com"


def test_duplicate_email_rejected(client: TestClient) -> None:
    assert register(client).status_code == 201
    r = register(client)
    assert r.status_code == 409
    assert r.json()["detail"] == MSG_DUPLICATE_EMAIL


def test_duplicate_email_rejected_case_insensitively(client: TestClient) -> None:
    """Uniqueness must survive case, or two accounts can own one address."""
    assert register(client, email="ana@northgate.com").status_code == 201
    r = register(client, email="ANA@NORTHGATE.COM")
    assert r.status_code == 409
    assert r.json()["detail"] == MSG_DUPLICATE_EMAIL


# ---------------------------------------------- registration password rules
# The messages are asserted verbatim: the frontend renders them, so a reworded
# message is a user-visible regression even when the status code is right.

def _first_message(response) -> str:
    return response.json()["detail"][0]["msg"].removeprefix("Value error, ")


def test_short_password_rejected(client: TestClient) -> None:
    r = register(client, password="short7")
    assert r.status_code == 422
    assert _first_message(r) == MSG_SHORT_PASSWORD


def test_common_password_rejected(client: TestClient) -> None:
    r = register(client, password="password123")
    assert r.status_code == 422
    assert _first_message(r) == MSG_COMMON_PASSWORD


def test_common_password_check_is_case_insensitive(client: TestClient) -> None:
    r = register(client, password="PassWord123")
    assert r.status_code == 422
    assert _first_message(r) == MSG_COMMON_PASSWORD


def test_password_containing_email_local_part_rejected(client: TestClient) -> None:
    r = register(client, email="maya.rahman@northgate.com", password="maya.rahman99")
    assert r.status_code == 422
    assert _first_message(r) == MSG_EMAIL_IN_PASSWORD


def test_short_local_part_is_not_checked_against_password(client: TestClient) -> None:
    """auth.js skips local parts under 4 chars because they collide with
    ordinary words; 'bob' inside 'bobsleigh-rider' is not evidence of anything."""
    r = register(client, email="bob@ironwood.co", password="bobsleigh-rider")
    assert r.status_code == 201


def test_invalid_email_rejected(client: TestClient) -> None:
    r = register(client, email="not-an-email")
    assert r.status_code == 422


# ------------------------------------------------------------ role hardening

def test_role_cannot_be_set_from_register_body(client: TestClient) -> None:
    """Privilege escalation via the request body is the single most damaging
    thing this endpoint could allow."""
    r = client.post(
        "/auth/register",
        json={"email": "sneaky@demo.com", "password": GOOD_PASSWORD, "role": "admin"},
    )
    # extra="forbid" rejects the unknown field outright rather than ignoring it.
    assert r.status_code == 422

    r2 = client.post(
        "/auth/register",
        json={"email": "sneaky@demo.com", "password": GOOD_PASSWORD},
    )
    assert r2.status_code == 201
    assert r2.json()["user"]["role"] == "customer"


# ------------------------------------------------------------------- login

def test_login_success(client: TestClient) -> None:
    register(client)
    r = login(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert REFRESH_COOKIE in r.cookies
    assert body["user"]["email"] == "ana@northgate.com"
    # 1 from the auto sign-in at registration, 1 from this login.
    assert body["user"]["login_count"] == 2
    assert body["user"]["last_login_at"] is not None


def test_login_is_case_insensitive_on_email(client: TestClient) -> None:
    register(client)
    r = login(client, email="ANA@Northgate.com")
    assert r.status_code == 200


def test_wrong_password_rejected(client: TestClient) -> None:
    register(client)
    r = login(client, password="definitely-not-it")
    assert r.status_code == 401
    assert r.json()["detail"] == MSG_BAD_CREDENTIALS


def test_unknown_email_and_wrong_password_are_indistinguishable(client: TestClient) -> None:
    """The anti-enumeration guarantee. If these two responses ever differ, the
    login form becomes a tool for discovering which addresses have accounts."""
    register(client)
    wrong_pw = login(client, password="definitely-not-it")
    unknown = login(client, email="nobody@nowhere.com", password="definitely-not-it")

    assert wrong_pw.status_code == unknown.status_code == 401
    assert wrong_pw.json() == unknown.json()


def test_disabled_account_rejected(client: TestClient, db_session) -> None:
    register(client)
    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    user.active = False
    db_session.commit()

    r = login(client)
    assert r.status_code == 403
    assert r.json()["detail"] == MSG_DISABLED


def test_disabled_account_rejected_on_authenticated_request(client: TestClient, db_session) -> None:
    """A token minted before the account was disabled must stop working at
    once, not when it expires."""
    token = register(client).json()["access_token"]
    assert client.get("/auth/me", headers=bearer(token)).status_code == 200

    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    user.active = False
    db_session.commit()

    r = client.get("/auth/me", headers=bearer(token))
    assert r.status_code == 403
    assert r.json()["detail"] == MSG_DISABLED


def test_login_rate_limited_after_repeated_failures(client: TestClient) -> None:
    register(client)
    for _ in range(5):
        assert login(client, password="wrong-one").status_code == 401
    r = login(client, password="wrong-one")
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_successful_login_clears_the_failure_counter(client: TestClient) -> None:
    register(client)
    for _ in range(3):
        assert login(client, password="wrong-one").status_code == 401
    assert login(client).status_code == 200
    # Counter reset, so the next three failures do not trip the limit.
    for _ in range(3):
        assert login(client, password="wrong-one").status_code == 401


# --------------------------------------------------------------- /auth/me

def test_me_with_token(client: TestClient) -> None:
    token = register(client, name="Ana Silva").json()["access_token"]
    r = client.get("/auth/me", headers=bearer(token))
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "ana@northgate.com"
    assert body["name"] == "Ana Silva"
    assert body["role"] == "customer"
    assert "hashed_password" not in body


def test_me_without_token(client: TestClient) -> None:
    r = client.get("/auth/me")
    assert r.status_code == 401


def test_me_with_malformed_token(client: TestClient) -> None:
    r = client.get("/auth/me", headers=bearer("not.a.jwt"))
    assert r.status_code == 401


def test_me_rejects_a_refresh_token(client: TestClient) -> None:
    """Both tokens carry the same signature; only the `type` claim separates
    them. A refresh token used as an access token must be refused."""
    refresh_token = refresh_cookie(register(client))
    r = client.get("/auth/me", headers=bearer(refresh_token))
    assert r.status_code == 401


def test_token_signed_with_another_key_rejected(client: TestClient) -> None:
    from jose import jwt

    forged = jwt.encode(
        {"sub": "00000000-0000-0000-0000-000000000000", "type": "access"},
        "an-attackers-own-key",
        algorithm="HS256",
    )
    assert client.get("/auth/me", headers=bearer(forged)).status_code == 401


# ------------------------------------------------------------ refresh/logout

def test_refresh_returns_a_new_pair(client: TestClient) -> None:
    refresh_token = refresh_cookie(register(client))
    r = client.post("/auth/refresh")
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert REFRESH_COOKIE in r.cookies
    assert client.get("/auth/me", headers=bearer(body["access_token"])).status_code == 200


def test_refresh_rejects_an_access_token(client: TestClient) -> None:
    access_token = register(client).json()["access_token"]
    # Registering set a valid refresh cookie; drop it, or the endpoint simply
    # uses that and the substitution is never actually tested.
    client.cookies.clear()
    client.cookies.set(REFRESH_COOKIE, access_token)
    r = client.post("/auth/refresh")
    assert r.status_code == 401


def test_refresh_rejects_a_disabled_account(client: TestClient, db_session) -> None:
    refresh_token = refresh_cookie(register(client))
    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    user.active = False
    db_session.commit()

    r = client.post("/auth/refresh")
    assert r.status_code == 403


def test_logout_requires_authentication(client: TestClient) -> None:
    assert client.post("/auth/logout").status_code == 401


def test_logout_succeeds_with_a_token(client: TestClient) -> None:
    token = register(client).json()["access_token"]
    r = client.post("/auth/logout", headers=bearer(token))
    assert r.status_code == 200
    assert r.json()["detail"] == "Signed out."


# ------------------------------------------------------------ require_admin

def test_require_admin_rejects_a_customer(client: TestClient) -> None:
    token = register(client).json()["access_token"]
    r = client.get("/test-only/admin-area", headers=bearer(token))
    assert r.status_code == 403
    assert r.json()["detail"] == "This action requires an administrator account."


def test_require_admin_rejects_an_anonymous_caller(client: TestClient) -> None:
    assert client.get("/test-only/admin-area").status_code == 401


def test_require_admin_allows_a_promoted_admin(client: TestClient, db_session) -> None:
    """Promotion is an out-of-band UPDATE - exactly what the README documents,
    since no endpoint can set a role."""
    register(client)
    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    user.role = "admin"
    db_session.commit()

    token = login(client).json()["access_token"]
    r = client.get("/test-only/admin-area", headers=bearer(token))
    assert r.status_code == 200


def test_stale_admin_token_stops_working_after_demotion(client: TestClient, db_session) -> None:
    """The role claim inside the token must not be trusted: require_admin reads
    the current role from the database on every request."""
    register(client)
    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    user.role = "admin"
    db_session.commit()

    token = login(client).json()["access_token"]
    assert client.get("/test-only/admin-area", headers=bearer(token)).status_code == 200

    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    user.role = "customer"
    db_session.commit()

    assert client.get("/test-only/admin-area", headers=bearer(token)).status_code == 403


# ------------------------------------------------------------------ health

def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ------------------------------------------------- usage events are recorded

def test_signup_and_login_write_usage_events(client: TestClient, db_session) -> None:
    """The reporting endpoints come later, but the rows must accumulate now."""
    from app.models import UsageEvent

    register(client)
    login(client)

    types = db_session.execute(select(UsageEvent.type).order_by(UsageEvent.ts)).scalars().all()
    assert "signup" in types
    assert types.count("login") == 2
