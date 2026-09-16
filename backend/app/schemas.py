"""Request and response models.

Every user-facing validation message here is copied verbatim from
assets/auth.js so the frontend's error rendering reads identically whether it
is talking to the demo provider or to this API.

No schema in this file exposes hashed_password. UserPublic is built from an
explicit field list rather than `from_attributes` over everything, so adding a
sensitive column to the model cannot silently leak it through a response.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

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


class UsageEventPublic(BaseModel):
    """Defined now so the later usage-tracking phase does not reshape the
    response contract after clients depend on it."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    type: str
    meta: dict[str, Any]
    ts: datetime
