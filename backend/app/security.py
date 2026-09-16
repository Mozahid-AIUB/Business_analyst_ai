"""Password hashing, JWT issuing/verification, and the auth dependencies.

This is the module that makes the move off localStorage meaningful: in the demo
provider every check ran on the client, so anyone could edit storage and grant
themselves admin. Here the checks run on the server and the client is never
trusted about who it is.
"""
from __future__ import annotations

import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Final, Literal

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .database import get_db
from .models import User
from .schemas import MSG_DISABLED

# bcrypt, not a bare hash: the cost factor is the point. 12 rounds is roughly
# a quarter-second per verification on current hardware - unnoticeable to a
# user, ruinous to anyone grinding a stolen table.
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)

TOKEN_TYPE_ACCESS: Final = "access"
TOKEN_TYPE_REFRESH: Final = "refresh"

# auto_error=False so a missing header reaches our own handler and returns the
# WWW-Authenticate challenge consistently with a malformed one.
bearer_scheme = HTTPBearer(auto_error=False)


# --------------------------------------------------------------- passwords

def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    # A malformed stored hash must read as "no match", not as a 500 that tells
    # an attacker something about the record.
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError:
        return False


# A bcrypt hash of a value no password can equal. Verified against when the
# email is unknown so the unknown-email path costs the same time as the
# wrong-password path - otherwise response latency enumerates accounts even
# though the message does not.
_DUMMY_HASH: Final = pwd_context.hash("not-a-real-password-" + uuid.uuid4().hex)


def waste_password_time() -> None:
    verify_password("x", _DUMMY_HASH)


# ------------------------------------------------------------------ tokens

def _create_token(
    subject: str,
    token_type: str,
    expires_delta: timedelta,
    extra: dict[str, Any] | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "iat": now,
        "exp": now + expires_delta,
        # A unique id per token, so a future deployment can maintain a
        # revocation list without reissuing the whole scheme.
        "jti": uuid.uuid4().hex,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.effective_secret_key, algorithm=settings.algorithm)


def create_access_token(user: User) -> str:
    # The role is carried in the token for cheap client-side rendering, but
    # require_admin re-reads it from the database: a token minted before a
    # demotion must not keep working until it expires.
    return _create_token(
        str(user.id),
        TOKEN_TYPE_ACCESS,
        timedelta(minutes=settings.access_token_expire_minutes),
        {"email": user.email, "role": user.role},
    )


def create_refresh_token(user: User) -> str:
    return _create_token(
        str(user.id), TOKEN_TYPE_REFRESH, timedelta(days=settings.refresh_token_expire_days)
    )


def decode_token(token: str, expected_type: Literal["access", "refresh"]) -> dict[str, Any]:
    """Decode and verify, raising 401 on anything unexpected.

    The explicit `type` check is what stops a refresh token being presented as
    an access token: both are signed with the same key, so the signature alone
    does not distinguish them.
    """
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.effective_secret_key, algorithms=[settings.algorithm])
    except JWTError:
        raise credentials_error
    if payload.get("type") != expected_type:
        raise credentials_error
    if not payload.get("sub"):
        raise credentials_error
    return payload


# ------------------------------------------------------------ rate limiting

class InMemoryRateLimiter:
    """Sliding-window counter keyed by client IP + email.

    IMPORTANT: this state lives in one process. Behind multiple uvicorn workers
    or more than one container each process keeps its own counter, so the
    effective limit becomes N times the configured one. Before scaling past a
    single worker this MUST move to Redis (INCR + EXPIRE on the same key) or to
    a reverse-proxy limiter. It is here because a limiter that exists is worth
    more than a perfect one that is deferred.
    """

    def __init__(self, max_attempts: int, window_seconds: int) -> None:
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> list[float]:
        recent = [t for t in self._hits.get(key, []) if now - t < self.window_seconds]
        if recent:
            self._hits[key] = recent
        else:
            self._hits.pop(key, None)
        return recent

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            recent = self._prune(key, now)
            if len(recent) >= self.max_attempts:
                retry_after = int(self.window_seconds - (now - recent[0])) + 1
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many sign-in attempts. Try again in a few minutes.",
                    headers={"Retry-After": str(retry_after)},
                )

    def register_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._hits.setdefault(key, []).append(now)
            self._prune(key, now)

    def reset(self, key: str) -> None:
        """Called on a successful sign-in: a legitimate user who mistyped twice
        should not carry those attempts for the rest of the window."""
        with self._lock:
            self._hits.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


login_rate_limiter = InMemoryRateLimiter(
    settings.login_rate_limit_attempts, settings.login_rate_limit_window_seconds
)


def client_ip(request: Request) -> str:
    # X-Forwarded-For is client-controlled unless a trusted proxy overwrites
    # it. Only the first hop is read, and only as a best effort - the limiter
    # is defence in depth, not an authorisation boundary.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ------------------------------------------------------------- dependencies

def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_token(credentials.credentials, TOKEN_TYPE_ACCESS)

    try:
        user_id = uuid.UUID(str(payload["sub"]))
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
    # Checked on every request, not only at login: disabling an account must
    # take effect immediately, not whenever the access token happens to expire.
    if not user.active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MSG_DISABLED)
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """403, not 404: the caller is authenticated, they simply may not do this."""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires an administrator account.",
        )
    return current_user
