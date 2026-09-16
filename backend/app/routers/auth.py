"""Authentication endpoints.

Scope is deliberately narrow: accounts and sessions. Scoring stays in the
browser (see backend/README.md) so customer CSVs never reach this server.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import User, UsageEvent
from ..schemas import (
    MSG_BAD_CREDENTIALS,
    MSG_DISABLED,
    MSG_DUPLICATE_EMAIL,
    AuthResponse,
    LoginRequest,
    MessageResponse,
    RefreshRequest,
    RegisterRequest,
    UserPublic,
)
from ..security import (
    TOKEN_TYPE_REFRESH,
    client_ip,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    login_rate_limiter,
    verify_password,
    waste_password_time,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _record_event(db: Session, user: User, event_type: str, meta: dict | None = None) -> None:
    """Write a usage row.

    The reporting endpoints that read these arrive in a later phase, but the
    rows have to start accumulating now - history that was never recorded
    cannot be backfilled.
    """
    db.add(UsageEvent(user_id=user.id, type=event_type, meta=meta or {}))


REFRESH_COOKIE = "sentinel_refresh"


def _set_refresh_cookie(response: Response, token: str) -> None:
    """The refresh token goes in an HttpOnly cookie, not the response body.

    The application renders user-supplied text (merchant names, memos, company
    names), so script injection is a real risk rather than a theoretical one.
    A refresh token readable by JavaScript is a permanent account takeover if
    that ever happens; one the browser holds but scripts cannot read is not.

    SameSite=lax still sends it on the top-level navigation that follows a
    sign-in, while keeping it off cross-site form posts. Secure is set outside
    development because a cookie sent over plain HTTP is a cookie in transit
    for anyone on the network.
    """
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=token,
        httponly=True,
        secure=settings.environment != "development",
        samesite="lax",
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/auth")


def _auth_response(user: User, response: Response) -> AuthResponse:
    """Mints both tokens, but only the access token reaches the caller; the
    refresh token is written straight into the HttpOnly cookie."""
    _set_refresh_cookie(response, create_refresh_token(user))
    return AuthResponse(
        access_token=create_access_token(user),
        expires_in=settings.access_token_expire_minutes * 60,
        user=UserPublic.model_validate(user),
    )


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an account and sign in",
)
def register(payload: RegisterRequest, response: Response, db: Session = Depends(get_db)) -> AuthResponse:
    """Password rules and their messages live in schemas.RegisterRequest, copied
    from auth.js so the frontend renders the same text it always has.

    `role` is not read from the request under any circumstance - the column
    default makes every new account a customer. Promotion is an out-of-band
    UPDATE; see backend/README.md.
    """
    existing = db.execute(select(User).where(User.email == payload.email)).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=MSG_DUPLICATE_EMAIL)

    user = User(
        email=payload.email,
        name=payload.name or payload.email.split("@")[0],
        company=payload.company or "—",
        role="customer",
        active=True,
        hashed_password=hash_password(payload.password),
        login_count=1,
        last_login_at=datetime.now(timezone.utc),
    )
    db.add(user)

    try:
        # Flush rather than commit so the unique-violation surfaces here, where
        # it can still be turned into the same 409 as the check above. The
        # SELECT is racy under concurrency; this constraint is what is
        # authoritative.
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=MSG_DUPLICATE_EMAIL)

    # auth.js signs the user straight in after signUp, hence both events and
    # the login_count of 1 above.
    _record_event(db, user, "signup")
    _record_event(db, user, "login")
    db.flush()
    return _auth_response(user, response)


@router.post("/login", response_model=AuthResponse, summary="Exchange credentials for tokens")
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> AuthResponse:
    """Unknown email and wrong password return the identical 401 body, and both
    perform a bcrypt verification, so neither the message nor the response time
    reveals whether an account exists.
    """
    rate_key = f"{client_ip(request)}|{payload.email}"
    login_rate_limiter.check(rate_key)

    user = db.execute(select(User).where(User.email == payload.email)).scalar_one_or_none()

    if user is None:
        waste_password_time()
        login_rate_limiter.register_failure(rate_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=MSG_BAD_CREDENTIALS)

    if not verify_password(payload.password, user.hashed_password):
        login_rate_limiter.register_failure(rate_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=MSG_BAD_CREDENTIALS)

    # Checked only after the password verifies. Reporting "disabled" to someone
    # who has not proved they own the account would confirm it exists.
    if not user.active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MSG_DISABLED)

    login_rate_limiter.reset(rate_key)
    user.last_login_at = datetime.now(timezone.utc)
    user.login_count = (user.login_count or 0) + 1
    _record_event(db, user, "login")
    db.flush()
    return _auth_response(user, response)


@router.post("/refresh", response_model=AuthResponse, summary="Exchange a refresh token for a new pair")
def refresh(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> AuthResponse:
    """Both tokens are reissued, so a client that refreshes regularly never
    reaches the refresh token's own expiry.

    The token is read from the HttpOnly cookie rather than a request body: the
    browser attaches it automatically and page scripts never see it.

    Without a server-side deny-list a leaked refresh token stays valid until it
    expires; see the "not yet implemented" list in backend/README.md.
    """
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token_payload = decode_token(raw, TOKEN_TYPE_REFRESH)

    import uuid as _uuid

    try:
        user_id = _uuid.UUID(str(token_payload["sub"]))
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MSG_DISABLED)

    return _auth_response(user, response)


@router.post("/logout", response_model=MessageResponse, summary="Record a sign-out")
def logout(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MessageResponse:
    """Records the event; the client discards its tokens.

    With stateless JWTs there is nothing server-side to invalidate, so an
    already-issued access token stays valid until it expires (30 minutes by
    default). Real revocation needs the jti deny-list noted in the README.
    """
    _record_event(db, current_user, "logout")
    db.flush()
    # Drop the cookie too, or the next visit silently refreshes back in.
    _clear_refresh_cookie(response)
    return MessageResponse(detail="Signed out.")


@router.get("/me", response_model=UserPublic, summary="The signed-in user's profile")
def me(current_user: User = Depends(get_current_user)) -> UserPublic:
    return UserPublic.model_validate(current_user)
