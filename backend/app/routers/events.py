"""Usage tracking and the admin console's read endpoints.

These are the endpoints the frontend already calls: `track` and `events` in
assets/auth.js map to POST/GET /events, and `listUsers`/`setActive` map to the
/admin/users pair. The contract here was read off that client rather than
invented, down to the query-parameter names and the camelCase response keys.

The rule that matters most in this module: a customer sees their own events and
nothing else. The client sends a `user_id` filter, but it is a filter, never a
grant - see `list_events`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Integer, case, func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import UsageEvent, User
from ..schemas import (
    MSG_CANNOT_DISABLE_ADMIN,
    MSG_USER_NOT_FOUND,
    AdminUserPublic,
    SetActiveRequest,
    TrackEventRequest,
    UsageEventPublic,
)
from ..security import get_current_user, require_admin

router = APIRouter(tags=["usage"])
admin_router = APIRouter(prefix="/admin", tags=["admin"])

# A page of history, not the whole table. admin.js renders at most 120 rows per
# history card and asks for no limit at all, so the default has to be a sane
# cap on the server side; the ceiling stops a caller asking for everything.
DEFAULT_EVENT_LIMIT = 500
MAX_EVENT_LIMIT = 2000


def _record_event(db: Session, user: User, event_type: str, meta: dict | None = None) -> None:
    """Write a usage row.

    Deliberately identical to auth.py's helper. It is duplicated rather than
    shared because the two routers are otherwise independent, and a four-line
    function is a poor reason to couple them.
    """
    db.add(UsageEvent(user_id=user.id, type=event_type, meta=meta or {}))


# The scan/health aggregate expressions, defined once and used by both
# list_users (grouped over everyone) and set_active (one user). Keeping them
# in one place is what stops the two views disagreeing about what a "scan" is.

def _scans_expr():
    return func.coalesce(func.sum(case((UsageEvent.type == "scan", 1), else_=0)), 0)


def _healths_expr():
    return func.coalesce(func.sum(case((UsageEvent.type == "health", 1), else_=0)), 0)


def _rows_expr():
    """Sum of meta.rows across scan events.

    COALESCE inside the sum as well as outside: SUM over no rows is NULL, and
    so is a scan whose meta carried no `rows` key. `rows` is a plain int on the
    response model, so neither may escape as None.

    The JSON member comes back as text on both backends, hence the cast - it
    sums rather than concatenates. A non-numeric value would fail that cast,
    which is part of why POST /events validates meta on the way in.
    """
    return func.coalesce(
        func.sum(
            case(
                (
                    UsageEvent.type == "scan",
                    func.coalesce(func.cast(UsageEvent.meta["rows"].as_string(), Integer), 0),
                ),
                else_=0,
            )
        ),
        0,
    )


def _with_stats(user: User, scans: int, healths: int, rows: int) -> AdminUserPublic:
    row = AdminUserPublic.model_validate(user)
    row.scans = int(scans or 0)
    row.healths = int(healths or 0)
    row.rows = int(rows or 0)
    return row


@router.post(
    "/events",
    response_model=UsageEventPublic,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
    summary="Record a usage event for the signed-in user",
)
def track_event(
    payload: TrackEventRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UsageEvent:
    """The subject is the bearer token's user, never the body.

    The demo provider's track() took a `userIdOverride`, which was harmless
    when every account lived in one browser and unacceptable the moment
    accounts are shared: it would let any customer forge history into another
    account. TrackEventRequest has no such field and forbids unknown ones, so
    an attempt to send one is a 422 rather than a silently ignored field.

    `type` is checked against a closed allowlist and `meta` against a size cap,
    both in the schema, so neither an invented category nor a multi-megabyte
    payload reaches the database.
    """
    event = UsageEvent(user_id=current_user.id, type=payload.type, meta=payload.meta)
    db.add(event)
    db.flush()
    return event


@router.get(
    "/events",
    response_model=list[UsageEventPublic],
    response_model_by_alias=True,
    summary="Usage events the caller is entitled to see",
)
def list_events(
    type: str | None = Query(default=None, description="Restrict to one event type."),
    user_id: uuid.UUID | None = Query(default=None, description="Admin only; overruled for customers."),
    since: datetime | None = Query(default=None, description="ISO timestamp; events at or after it."),
    limit: int = Query(default=DEFAULT_EVENT_LIMIT, ge=1, le=MAX_EVENT_LIMIT),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[UsageEvent]:
    """Newest first, capped by `limit`.

    THE AUTHORISATION RULE: a customer's results are pinned to their own id
    before any query parameter is considered. A `user_id` from a customer is
    not rejected - auth.js sends it as an ordinary filter, and a 400 would
    break a console that is merely being specific - it is overruled. Passing
    someone else's id returns the caller's own events, never the other
    account's.

    An admin may filter by `user_id`, or omit it and see everyone, which is
    what the console's unfiltered `Auth.events()` call does.
    """
    stmt = select(UsageEvent)

    if current_user.role == "admin":
        if user_id is not None:
            stmt = stmt.where(UsageEvent.user_id == user_id)
    else:
        # Not guarded by `if user_id is not None` - the scope is pinned
        # unconditionally, so there is no branch in which a customer's
        # visibility depends on what they sent.
        stmt = stmt.where(UsageEvent.user_id == current_user.id)

    if type:
        stmt = stmt.where(UsageEvent.type == type)
    if since is not None:
        # A naive timestamp is read as UTC: comparing naive to aware raises on
        # PostgreSQL, and everything stored here is UTC anyway.
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        stmt = stmt.where(UsageEvent.ts >= since)

    # ts then id: rows written in one transaction can share a timestamp, and
    # without the tiebreak their relative order varies between queries.
    stmt = stmt.order_by(UsageEvent.ts.desc(), UsageEvent.id.desc()).limit(limit)
    return list(db.execute(stmt).scalars().all())


@admin_router.get(
    "/users",
    response_model=list[AdminUserPublic],
    response_model_by_alias=True,
    summary="Every account, with its usage aggregates",
)
def list_users(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[AdminUserPublic]:
    """The console shows scans, rows processed and health scores per user.

    Those aggregates come from one grouped query rather than from loading the
    event table into Python: the browser version walked every event once per
    row it drew, which is fine for a seeded demo and quadratic against real
    history.

    A LEFT JOIN, not an inner one - an account that has never run a scan still
    has to appear in the list, with zeroes.
    """
    stmt = (
        select(
            User,
            _scans_expr().label("scans"),
            _healths_expr().label("healths"),
            _rows_expr().label("rows"),
        )
        .outerjoin(UsageEvent, UsageEvent.user_id == User.id)
        .group_by(User.id)
        .order_by(User.created_at.asc())
    )

    return [_with_stats(user, scans, healths, rows) for user, scans, healths, rows in db.execute(stmt).all()]


@admin_router.patch(
    "/users/{user_id}",
    response_model=AdminUserPublic,
    response_model_by_alias=True,
    summary="Enable or disable an account",
)
def set_active(
    user_id: uuid.UUID,
    payload: SetActiveRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserPublic:
    """Mirrors the demo provider's setActive, including its refusal to disable
    an administrator, with the same sentence.

    That rule is not ceremony. The console is reachable only by admins, and no
    endpoint can grant the role back - promotion is out-of-band SQL, see
    backend/README.md - so an admin who disables the last admin account locks
    everyone out of the console with no in-product way back. Refusing here is
    far cheaper than the recovery, and it also blocks one admin disabling
    another.

    The toggle is itself recorded: an account being switched off is exactly the
    kind of change someone later needs to account for.
    """
    target = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=MSG_USER_NOT_FOUND)

    # Keyed on the target's role, not on `target.id == admin.id`: disabling any
    # admin is refused, not merely disabling yourself.
    if target.role == "admin" and not payload.active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=MSG_CANNOT_DISABLE_ADMIN)

    target.active = payload.active
    _record_event(
        db,
        admin,
        "admin_toggle_user",
        {"target_user_id": str(target.id), "active": payload.active},
    )
    db.flush()

    scans, healths, rows = db.execute(
        select(_scans_expr(), _healths_expr(), _rows_expr()).where(UsageEvent.user_id == target.id)
    ).one()
    return _with_stats(target, scans, healths, rows)
