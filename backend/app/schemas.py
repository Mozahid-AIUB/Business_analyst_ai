"""Request and response models.

Every user-facing validation message here is copied verbatim from
assets/auth.js so the frontend's error rendering reads identically whether it
is talking to the demo provider or to this API.

No schema in this file exposes hashed_password. UserPublic is built from an
explicit field list rather than `from_attributes` over everything, so adding a
sensitive column to the model cannot silently leak it through a response.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

# The list from assets/auth.js, unchanged. Kept identical so a password the
# demo provider rejected is not silently accepted by the real backend.
# A production deployment should check a downloaded top-100k list instead;
# this is the same rule at the same scale as the frontend it replaces.
COMMON_PASSWORDS: frozenset[str] = frozenset(
    {
        "password", "password1", "password123", "12345678", "123456789", "qwerty123",
        "letmein", "welcome1", "admin123", "abc12345", "iloveyou", "sunshine",
        "football", "monkey123",
    }
)

MIN_PASSWORD_LENGTH = 8
# bcrypt silently truncates beyond 72 bytes, so a longer password would give a
# false sense of strength. Rejected explicitly instead.
MAX_PASSWORD_LENGTH = 72

MSG_INVALID_EMAIL = "Enter a valid email address."
MSG_SHORT_PASSWORD = "Use a password of at least 8 characters."
MSG_COMMON_PASSWORD = "That password is too common. Choose something less guessable."
MSG_EMAIL_IN_PASSWORD = "Your password should not contain your email address."
MSG_DUPLICATE_EMAIL = "An account already exists for that email. Sign in instead."
MSG_BAD_CREDENTIALS = "That email and password do not match."
MSG_DISABLED = "This account has been disabled. Contact your administrator."


def normalise_email(email: str) -> str:
    """Mirror of auth.js normaliseEmail - the lowercasing that makes a plain
    unique index behave like citext."""
    return str(email or "").strip().lower()


def is_common_password(password: str) -> bool:
    return password.lower() in COMMON_PASSWORDS


def contains_email_local_part(password: str, email: str) -> bool:
    """A password built out of the address it protects is guessable by anyone
    who knows the address. Local parts under 4 chars ('bob', 'hr') collide with
    ordinary words too often to be evidence of anything - same rule as auth.js.
    """
    local = normalise_email(email).split("@")[0]
    if len(local) < 4:
        return False
    return local in password.lower()


class RegisterRequest(BaseModel):
    """Note the absence of `role`. It is not optional-and-ignored, it is absent:
    an unknown field cannot be smuggled through, and a client that sends one
    gets a 422 rather than a silent downgrade."""

    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str
    name: str | None = None
    company: str | None = None

    @field_validator("email")
    @classmethod
    def _normalise(cls, v: str) -> str:
        return normalise_email(v)

    @model_validator(mode="after")
    def _check_password(self) -> "RegisterRequest":
        pw = self.password or ""
        if len(pw) < MIN_PASSWORD_LENGTH:
            raise ValueError(MSG_SHORT_PASSWORD)
        if len(pw.encode("utf-8")) > MAX_PASSWORD_LENGTH:
            raise ValueError(f"Use a password of at most {MAX_PASSWORD_LENGTH} characters.")
        if is_common_password(pw):
            raise ValueError(MSG_COMMON_PASSWORD)
        if contains_email_local_part(pw, self.email):
            raise ValueError(MSG_EMAIL_IN_PASSWORD)

        # auth.js falls back to the email local part for a missing name and an
        # em dash for a missing company; the frontend renders both directly.
        if not (self.name or "").strip():
            self.name = self.email.split("@")[0]
        else:
            self.name = self.name.strip()
        if not (self.company or "").strip():
            self.company = "—"
        else:
            self.company = self.company.strip()
        return self


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def _normalise(cls, v: str) -> str:
        return normalise_email(v)


class RefreshRequest(BaseModel):
    """Empty by design. The refresh token arrives in an HttpOnly cookie that
    JavaScript cannot read, so there is nothing for a client to put in a body.
    Kept as a model so the endpoint still rejects unexpected fields."""

    model_config = ConfigDict(extra="forbid")


class UserPublic(BaseModel):
    """The shape auth.js calls publicUser(). Field names match so app.js needs
    no change beyond where the data comes from."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    name: str
    company: str
    role: str
    active: bool
    created_at: datetime
    last_login_at: datetime | None
    login_count: int


class TokenPair(BaseModel):
    """Only the access token is returned to the caller.

    The refresh token is deliberately absent: it is set as an HttpOnly cookie
    instead, so a script injected into the page cannot read it. Returning it
    here would make any XSS a permanent account takeover rather than a
    session-length one."""

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = Field(description="Access token lifetime in seconds.")


class AuthResponse(TokenPair):
    """Returned by register, login and refresh: tokens plus the profile, so the
    client does not need a second round trip to render a signed-in header."""

    user: UserPublic


class MessageResponse(BaseModel):
    detail: str


# ------------------------------------------------------------ usage events

# The allowlist is closed, not advisory. `type` reaches an indexed column that
# the admin console groups on, so an open field would let any signed-in caller
# invent categories the console then renders. Every value here is one that
# app.js or admin.js actually emits or reads.
EVENT_TYPES: frozenset[str] = frozenset(
    {
        "login", "signup", "logout", "scan", "health",
        "portfolio", "export", "retrain", "admin_toggle_user",
    }
)

# 4 KiB of serialised JSON. Generous for the summary objects app.js sends
# (row counts, exposure totals, a filename) and far too small to be worth
# using as free storage. Enforced on the serialised length rather than the key
# count because one long string is the cheap way to abuse a dict-shaped limit.
MAX_META_BYTES = 4096

MSG_UNKNOWN_EVENT_TYPE = "That event type is not recognised."
MSG_META_TOO_LARGE = "That event's metadata is too large."
# Copied verbatim from the demo provider's setActive, so the console renders
# the same sentence whichever provider is behind it.
MSG_CANNOT_DISABLE_ADMIN = "An administrator account cannot be disabled here."
MSG_USER_NOT_FOUND = "No such user."


def _epoch_ms(value: datetime | None) -> int | None:
    """Datetime to epoch milliseconds, the way the frontend already reads them.

    admin.js does arithmetic on these values - `now - u.lastLoginAt`,
    `(e.ts - first) / dayMs`, `(b.lastLoginAt || 0) - (a.lastLoginAt || 0)` -
    which only works on numbers. An ISO string would survive `new Date(...)`
    and then silently produce NaN in every one of those expressions, which is
    precisely the class of mismatch this contract is written to avoid.

    Naive datetimes are read as UTC: SQLite hands back tz-naive values even
    though the column is declared with timezone=True, and everything written
    here is UTC.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


class TrackEventRequest(BaseModel):
    """The body of POST /events.

    There is deliberately no `user_id`. The demo provider accepted a
    `userIdOverride` because it had no one to lie to; here the subject comes
    from the bearer token and nowhere else, so a customer cannot write rows
    into another account's history. extra="forbid" makes an attempt to send
    one a 422 rather than a silently ignored field.
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    meta: dict[str, Any] = Field(default_factory=dict)

    @field_validator("type")
    @classmethod
    def _known_type(cls, v: str) -> str:
        v = (v or "").strip()
        if v not in EVENT_TYPES:
            raise ValueError(MSG_UNKNOWN_EVENT_TYPE)
        return v

    @field_validator("meta")
    @classmethod
    def _bounded_meta(cls, v: dict[str, Any]) -> dict[str, Any]:
        # Measured after serialisation, which is what actually lands in the
        # column. json.dumps also rejects values the JSON column could not
        # store, turning a would-be 500 into a 422.
        try:
            encoded = json.dumps(v, default=str)
        except (TypeError, ValueError):
            raise ValueError(MSG_META_TOO_LARGE)
        if len(encoded.encode("utf-8")) > MAX_META_BYTES:
            raise ValueError(MSG_META_TOO_LARGE)
        return v


class SetActiveRequest(BaseModel):
    """The body of PATCH /admin/users/{user_id}.

    `active` only. Role is not settable through any endpoint - see the
    promotion section of backend/README.md."""

    model_config = ConfigDict(extra="forbid")

    active: bool


class UsageEventPublic(BaseModel):
    """One usage row in the shape admin.js already reads.

    It reads `e.ts`, `e.meta`, `e.userId` and `e.type`; the Python side is
    snake_case. The bridge is serialisation aliases rather than a rename of
    the columns, so the ORM, the queries and the tests stay idiomatic Python
    and the wire format stays exactly what the frontend expects.
    """

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    user_id: uuid.UUID = Field(serialization_alias="userId")
    type: str
    meta: dict[str, Any]
    ts: datetime

    @field_serializer("ts")
    def _ts_ms(self, value: datetime) -> int | None:
        return _epoch_ms(value)

    @field_serializer("id", "user_id")
    def _ids_as_str(self, value: uuid.UUID) -> str:
        # admin.js uses these as object keys (`byId[e.userId]`), so they must
        # be plain strings on the wire.
        return str(value)


class AdminUserPublic(BaseModel):
    """A user row for the admin console: the demo provider's publicUser()
    shape, plus the aggregates the console used to recompute in the browser.

    `seeded` is always false. It marked the demo provider's generated sample
    accounts; no row created through this API is sample data, but the field is
    still emitted because admin.js reads `u.seeded` unconditionally and renders
    a 'sample' chip from it.
    """

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    email: EmailStr
    name: str
    company: str
    role: str
    active: bool
    created_at: datetime = Field(serialization_alias="createdAt")
    last_login_at: datetime | None = Field(serialization_alias="lastLoginAt")
    login_count: int = Field(serialization_alias="loginCount")
    seeded: bool = False

    # Aggregates, computed by a grouped query rather than by shipping every
    # event to the browser. admin.js reads scans/healths/rows off its own
    # userStats() helper today; these let it stop walking the event list.
    scans: int = 0
    healths: int = 0
    rows: int = 0

    @field_serializer("created_at", "last_login_at")
    def _times_as_ms(self, value: datetime | None) -> int | None:
        return _epoch_ms(value)

    @field_serializer("id")
    def _id_as_str(self, value: uuid.UUID) -> str:
        return str(value)
