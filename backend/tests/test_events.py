"""Usage-tracking and admin endpoint tests.

Same fixtures as test_auth.py: a fresh in-memory SQLite database per test, so
ordering never matters and nothing leaks between cases.

The tests that matter most here are the authorisation ones. Every check these
endpoints perform used to run in the browser, where a customer could simply
edit localStorage; the point of moving them is that the server now says no,
so "a customer cannot read another customer's events" is asserted directly
rather than assumed from the code reading correctly.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.models import UsageEvent, User
from app.schemas import (
    MSG_CANNOT_DISABLE_ADMIN,
    MSG_META_TOO_LARGE,
    MSG_UNKNOWN_EVENT_TYPE,
)
from tests.test_auth import GOOD_PASSWORD, bearer, register


def promote(db_session, email: str) -> User:
    """Promotion is an out-of-band UPDATE - no endpoint can set a role."""
    user = db_session.execute(select(User).where(User.email == email)).scalar_one()
    user.role = "admin"
    db_session.commit()
    return user


def admin_token(client: TestClient, db_session, email: str = "root@sentinel.com") -> str:
    register(client, email=email)
    promote(db_session, email)
    # A fresh token, so the role claim inside it matches the database.
    return client.post("/auth/login", json={"email": email, "password": GOOD_PASSWORD}).json()["access_token"]


def customer_token(client: TestClient, email: str) -> str:
    return register(client, email=email).json()["access_token"]


def user_id_of(db_session, email: str) -> str:
    return str(db_session.execute(select(User).where(User.email == email)).scalar_one().id)


def track(client: TestClient, token: str, type_: str = "scan", meta: dict | None = None):
    return client.post("/events", json={"type": type_, "meta": meta or {}}, headers=bearer(token))


# ----------------------------------------------------------- POST /events

def test_track_records_an_event_for_the_token_holder(client: TestClient, db_session) -> None:
    token = customer_token(client, "ana@northgate.com")
    r = track(client, token, "scan", {"rows": 120, "file": "march.csv"})
    assert r.status_code == 201, r.text

    body = r.json()
    assert body["type"] == "scan"
    assert body["meta"] == {"rows": 120, "file": "march.csv"}
    assert body["userId"] == user_id_of(db_session, "ana@northgate.com")


def test_track_requires_authentication(client: TestClient) -> None:
    assert client.post("/events", json={"type": "scan", "meta": {}}).status_code == 401


def test_track_rejects_an_unknown_type(client: TestClient) -> None:
    """The allowlist is closed. `type` reaches an indexed column the console
    groups on, so an open field would let any caller invent categories."""
    token = customer_token(client, "ana@northgate.com")
    r = track(client, token, "definitely-not-a-real-type")
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"].removeprefix("Value error, ") == MSG_UNKNOWN_EVENT_TYPE


def test_track_rejects_an_oversized_meta(client: TestClient, db_session) -> None:
    """The cap is what stops usage tracking being used as free storage."""
    token = customer_token(client, "ana@northgate.com")
    r = track(client, token, "scan", {"padding": "x" * 5000})
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"].removeprefix("Value error, ") == MSG_META_TOO_LARGE

    # And nothing was written: a rejected request must not leave a row behind.
    assert db_session.execute(select(UsageEvent).where(UsageEvent.type == "scan")).first() is None


def test_track_accepts_meta_just_under_the_cap(client: TestClient) -> None:
    """The boundary in the other direction, so the cap cannot quietly become
    far stricter than documented."""
    token = customer_token(client, "ana@northgate.com")
    assert track(client, token, "scan", {"padding": "x" * 4000}).status_code == 201


def test_track_cannot_forge_another_users_event(client: TestClient, db_session) -> None:
    """The demo provider's track() accepted a userIdOverride. Sending one here
    is a 422, not a silently ignored field - and certainly not an event
    attributed to someone else."""
    victim = customer_token(client, "victim@northgate.com")  # noqa: F841 - creates the account
    attacker = customer_token(client, "mallory@elsewhere.com")
    victim_id = user_id_of(db_session, "victim@northgate.com")

    r = client.post(
        "/events",
        json={"type": "scan", "meta": {}, "user_id": victim_id},
        headers=bearer(attacker),
    )
    assert r.status_code == 422

    rows = db_session.execute(select(UsageEvent).where(UsageEvent.type == "scan")).scalars().all()
    assert rows == []


# ------------------------------------------------------------ GET /events

def test_customer_sees_only_their_own_events(client: TestClient, db_session) -> None:
    ana = customer_token(client, "ana@northgate.com")
    ben = customer_token(client, "ben@ironwood.co")
    track(client, ana, "scan", {"rows": 10})
    track(client, ben, "scan", {"rows": 99})

    ana_id = user_id_of(db_session, "ana@northgate.com")
    body = client.get("/events", headers=bearer(ana)).json()

    assert body, "the caller should still see their own history"
    assert {e["userId"] for e in body} == {ana_id}


def test_customer_passing_another_user_id_still_gets_only_their_own(
    client: TestClient, db_session
) -> None:
    """The filter is a filter, never a grant.

    This is the single most important assertion in the file: the client sends
    `user_id` and the server must overrule it for a customer rather than trust
    it. If this ever fails, any signed-in customer can read every other
    customer's activity by changing one query parameter.
    """
    ana = customer_token(client, "ana@northgate.com")
    ben = customer_token(client, "ben@ironwood.co")
    track(client, ben, "scan", {"rows": 99, "file": "bens-private-book.csv"})
    track(client, ana, "scan", {"rows": 10})

    ana_id = user_id_of(db_session, "ana@northgate.com")
    ben_id = user_id_of(db_session, "ben@ironwood.co")

    r = client.get(f"/events?user_id={ben_id}", headers=bearer(ana))
    assert r.status_code == 200
    body = r.json()

    assert {e["userId"] for e in body} == {ana_id}
    assert all(e["userId"] != ben_id for e in body)
    assert "bens-private-book.csv" not in r.text


def test_admin_sees_everyones_events(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    ana = customer_token(client, "ana@northgate.com")
    ben = customer_token(client, "ben@ironwood.co")
    track(client, ana, "scan", {"rows": 10})
    track(client, ben, "scan", {"rows": 99})

    body = client.get("/events", headers=bearer(root)).json()
    seen = {e["userId"] for e in body}
    assert user_id_of(db_session, "ana@northgate.com") in seen
    assert user_id_of(db_session, "ben@ironwood.co") in seen


def test_admin_can_filter_by_user_id(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    ana = customer_token(client, "ana@northgate.com")
    ben = customer_token(client, "ben@ironwood.co")
    track(client, ana, "scan", {"rows": 10})
    track(client, ben, "scan", {"rows": 99})

    ana_id = user_id_of(db_session, "ana@northgate.com")
    body = client.get(f"/events?user_id={ana_id}", headers=bearer(root)).json()
    assert {e["userId"] for e in body} == {ana_id}


def test_events_filter_by_type(client: TestClient) -> None:
    token = customer_token(client, "ana@northgate.com")
    track(client, token, "scan", {"rows": 10})
    track(client, token, "health", {"score": 7.5})

    body = client.get("/events?type=scan", headers=bearer(token)).json()
    assert [e["type"] for e in body] == ["scan"]


def test_events_filter_by_since(client: TestClient, db_session) -> None:
    """`since` is an ISO timestamp, exactly as auth.js sends it."""
    token = customer_token(client, "ana@northgate.com")
    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()

    old = UsageEvent(
        user_id=user.id,
        type="scan",
        meta={"file": "ancient.csv"},
        ts=datetime.now(timezone.utc) - timedelta(days=30),
    )
    db_session.add(old)
    db_session.commit()

    track(client, token, "scan", {"file": "today.csv"})

    cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    # Passed as params so the "+00:00" offset is percent-encoded, which is what
    # auth.js's encodeURIComponent does. Interpolated raw into the query string
    # the "+" would decode as a space and the timestamp would not parse.
    r = client.get("/events", params={"since": cutoff, "type": "scan"}, headers=bearer(token))
    assert r.status_code == 200, r.text
    files = [e["meta"].get("file") for e in r.json()]
    assert "today.csv" in files
    assert "ancient.csv" not in files


def test_events_since_accepts_a_z_suffixed_timestamp(client: TestClient) -> None:
    """new Date(...).toISOString() in the browser always ends in "Z", which is
    the form auth.js actually sends."""
    token = customer_token(client, "ana@northgate.com")
    track(client, token, "scan", {"file": "today.csv"})

    cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    r = client.get("/events", params={"since": cutoff}, headers=bearer(token))
    assert r.status_code == 200, r.text
    assert any(e["meta"].get("file") == "today.csv" for e in r.json())


def test_events_rejects_an_unparseable_since(client: TestClient) -> None:
    token = customer_token(client, "ana@northgate.com")
    r = client.get("/events", params={"since": "not-a-timestamp"}, headers=bearer(token))
    assert r.status_code == 422


def test_events_are_newest_first(client: TestClient, db_session) -> None:
    token = customer_token(client, "ana@northgate.com")
    user = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            UsageEvent(user_id=user.id, type="scan", meta={"n": 1}, ts=now - timedelta(hours=3)),
            UsageEvent(user_id=user.id, type="scan", meta={"n": 3}, ts=now - timedelta(hours=1)),
            UsageEvent(user_id=user.id, type="scan", meta={"n": 2}, ts=now - timedelta(hours=2)),
        ]
    )
    db_session.commit()

    body = client.get("/events?type=scan", headers=bearer(token)).json()
    assert [e["meta"]["n"] for e in body] == [3, 2, 1]
    # ts is epoch milliseconds, which is what admin.js does arithmetic on.
    assert all(isinstance(e["ts"], int) for e in body)


def test_events_limit_is_capped(client: TestClient) -> None:
    token = customer_token(client, "ana@northgate.com")
    assert client.get("/events?limit=1", headers=bearer(token)).status_code == 200
    # Above the ceiling is a 422, not a silently clamped full-table scan.
    assert client.get("/events?limit=99999", headers=bearer(token)).status_code == 422


def test_events_requires_authentication(client: TestClient) -> None:
    assert client.get("/events").status_code == 401


# ------------------------------------------------------- GET /admin/users

def test_admin_users_rejects_a_customer(client: TestClient) -> None:
    token = customer_token(client, "ana@northgate.com")
    r = client.get("/admin/users", headers=bearer(token))
    assert r.status_code == 403
    assert r.json()["detail"] == "This action requires an administrator account."


def test_admin_users_rejects_an_anonymous_caller(client: TestClient) -> None:
    assert client.get("/admin/users").status_code == 401


def test_admin_users_returns_everyone(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    customer_token(client, "ana@northgate.com")
    customer_token(client, "ben@ironwood.co")

    body = client.get("/admin/users", headers=bearer(root)).json()
    assert {u["email"] for u in body} == {
        "root@sentinel.com",
        "ana@northgate.com",
        "ben@ironwood.co",
    }


def test_admin_users_uses_the_camelcase_keys_the_console_reads(
    client: TestClient, db_session
) -> None:
    """admin.js reads u.createdAt, u.lastLoginAt, u.loginCount and u.seeded,
    and does arithmetic on the timestamps (`now - u.lastLoginAt`). Snake_case
    or an ISO string would both render as NaN rather than failing loudly, which
    is exactly the silent mismatch this asserts against."""
    root = admin_token(client, db_session)
    body = client.get("/admin/users", headers=bearer(root)).json()
    row = [u for u in body if u["email"] == "root@sentinel.com"][0]

    for key in ("createdAt", "lastLoginAt", "loginCount", "seeded", "scans", "healths", "rows"):
        assert key in row, f"admin.js reads {key}"
    for absent in ("created_at", "last_login_at", "login_count", "hashed_password"):
        assert absent not in row

    assert isinstance(row["createdAt"], int)
    assert isinstance(row["lastLoginAt"], int)
    assert row["seeded"] is False


def test_admin_users_never_leaks_password_material(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    r = client.get("/admin/users", headers=bearer(root))
    assert "hashed_password" not in r.text
    assert GOOD_PASSWORD not in r.text
    assert "$2b$" not in r.text


def test_admin_users_aggregates_are_correct(client: TestClient, db_session) -> None:
    """Known events in, known counts out.

    The aggregates are computed in SQL, so this is the test that catches a
    grouped query that joins wrong - the failure mode there is one user's
    totals silently including another's.
    """
    root = admin_token(client, db_session)
    ana = customer_token(client, "ana@northgate.com")
    ben = customer_token(client, "ben@ironwood.co")

    # Ana: 3 scans totalling 60 rows, 2 health scores.
    track(client, ana, "scan", {"rows": 10})
    track(client, ana, "scan", {"rows": 20})
    track(client, ana, "scan", {"rows": 30})
    track(client, ana, "health", {"score": 7.1})
    track(client, ana, "health", {"score": 6.2})
    # An export must not count towards any of the three aggregates.
    track(client, ana, "export", {"file": "book.csv"})

    # Ben: 1 scan of 5 rows, no health scores.
    track(client, ben, "scan", {"rows": 5})

    body = client.get("/admin/users", headers=bearer(root)).json()
    by_email = {u["email"]: u for u in body}

    assert (by_email["ana@northgate.com"]["scans"], by_email["ana@northgate.com"]["rows"]) == (3, 60)
    assert by_email["ana@northgate.com"]["healths"] == 2

    assert (by_email["ben@ironwood.co"]["scans"], by_email["ben@ironwood.co"]["rows"]) == (1, 5)
    assert by_email["ben@ironwood.co"]["healths"] == 0

    # The admin ran nothing: a user with no events must still appear, at zero,
    # which is what the LEFT JOIN is for.
    assert (by_email["root@sentinel.com"]["scans"], by_email["root@sentinel.com"]["rows"]) == (0, 0)
    assert by_email["root@sentinel.com"]["healths"] == 0


def test_admin_users_aggregates_tolerate_a_scan_without_rows(
    client: TestClient, db_session
) -> None:
    """meta is free-form, so `rows` may simply be absent. That must read as
    zero rather than as NULL reaching an int field."""
    root = admin_token(client, db_session)
    ana = customer_token(client, "ana@northgate.com")
    track(client, ana, "scan", {"file": "no-row-count.csv"})
    track(client, ana, "scan", {"rows": 7})

    body = client.get("/admin/users", headers=bearer(root)).json()
    row = [u for u in body if u["email"] == "ana@northgate.com"][0]
    assert row["scans"] == 2
    assert row["rows"] == 7


# ----------------------------------------------------- PATCH /admin/users

def test_patch_disables_a_customer(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    customer_token(client, "ana@northgate.com")
    ana_id = user_id_of(db_session, "ana@northgate.com")

    r = client.patch(f"/admin/users/{ana_id}", json={"active": False}, headers=bearer(root))
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False

    # And it takes effect immediately, not at token expiry.
    assert client.post("/auth/login", json={"email": "ana@northgate.com", "password": GOOD_PASSWORD}).status_code == 403


def test_patch_can_re_enable(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    customer_token(client, "ana@northgate.com")
    ana_id = user_id_of(db_session, "ana@northgate.com")

    client.patch(f"/admin/users/{ana_id}", json={"active": False}, headers=bearer(root))
    r = client.patch(f"/admin/users/{ana_id}", json={"active": True}, headers=bearer(root))
    assert r.status_code == 200
    assert r.json()["active"] is True


def test_patch_refuses_to_disable_an_admin(client: TestClient, db_session) -> None:
    """auth.js's rule, with auth.js's sentence. No endpoint can grant the admin
    role back, so disabling the last admin would be unrecoverable in-product."""
    root = admin_token(client, db_session)
    root_id = user_id_of(db_session, "root@sentinel.com")

    r = client.patch(f"/admin/users/{root_id}", json={"active": False}, headers=bearer(root))
    assert r.status_code == 409
    assert r.json()["detail"] == MSG_CANNOT_DISABLE_ADMIN

    db_session.expire_all()
    still = db_session.execute(select(User).where(User.email == "root@sentinel.com")).scalar_one()
    assert still.active is True


def test_patch_refuses_to_disable_another_admin(client: TestClient, db_session) -> None:
    """The rule is about the target's role, not about self-disabling: one admin
    must not be able to switch off another."""
    root = admin_token(client, db_session)
    register(client, email="second@sentinel.com")
    promote(db_session, "second@sentinel.com")
    second_id = user_id_of(db_session, "second@sentinel.com")

    r = client.patch(f"/admin/users/{second_id}", json={"active": False}, headers=bearer(root))
    assert r.status_code == 409
    assert r.json()["detail"] == MSG_CANNOT_DISABLE_ADMIN


def test_patch_rejects_a_customer(client: TestClient, db_session) -> None:
    ana = customer_token(client, "ana@northgate.com")
    customer_token(client, "ben@ironwood.co")
    ben_id = user_id_of(db_session, "ben@ironwood.co")

    r = client.patch(f"/admin/users/{ben_id}", json={"active": False}, headers=bearer(ana))
    assert r.status_code == 403

    db_session.expire_all()
    ben = db_session.execute(select(User).where(User.email == "ben@ironwood.co")).scalar_one()
    assert ben.active is True


def test_patch_rejects_an_unknown_field(client: TestClient, db_session) -> None:
    """Notably `role`: privilege escalation through this body would be the most
    damaging thing the endpoint could allow."""
    root = admin_token(client, db_session)
    customer_token(client, "ana@northgate.com")
    ana_id = user_id_of(db_session, "ana@northgate.com")

    r = client.patch(
        f"/admin/users/{ana_id}",
        json={"active": True, "role": "admin"},
        headers=bearer(root),
    )
    assert r.status_code == 422

    db_session.expire_all()
    ana = db_session.execute(select(User).where(User.email == "ana@northgate.com")).scalar_one()
    assert ana.role == "customer"


def test_patch_unknown_user_is_404(client: TestClient, db_session) -> None:
    root = admin_token(client, db_session)
    r = client.patch(
        "/admin/users/00000000-0000-0000-0000-000000000000",
        json={"active": False},
        headers=bearer(root),
    )
    assert r.status_code == 404


def test_patch_records_the_toggle(client: TestClient, db_session) -> None:
    """Switching an account off is exactly the kind of change someone later
    needs to account for."""
    root = admin_token(client, db_session)
    customer_token(client, "ana@northgate.com")
    ana_id = user_id_of(db_session, "ana@northgate.com")

    client.patch(f"/admin/users/{ana_id}", json={"active": False}, headers=bearer(root))

    row = db_session.execute(
        select(UsageEvent).where(UsageEvent.type == "admin_toggle_user")
    ).scalar_one()
    assert row.user_id == db_session.execute(
        select(User.id).where(User.email == "root@sentinel.com")
    ).scalar_one()
    assert row.meta["target_user_id"] == ana_id
    assert row.meta["active"] is False
