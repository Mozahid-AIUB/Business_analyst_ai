"""ORM models.

The shape mirrors the SQL sketched at the bottom of assets/auth.js, so the
frontend's existing field names survive the move off localStorage unchanged.

UsageEvent exists now even though nothing writes to it yet: adding a table
later is cheap, but backfilling history that was never recorded is impossible.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON, CHAR, TypeDecorator

from .database import Base


class GUID(TypeDecorator):
    """UUID that is native on PostgreSQL and a 36-char string on SQLite/MySQL.

    Keeping the Python side a real `uuid.UUID` on every backend means no
    endpoint or test has to care which database it is talking to.
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value: Any, dialect) -> Any:
        if value is None:
            return None
        if not isinstance(value, uuid.UUID):
            value = uuid.UUID(str(value))
        return value if dialect.name == "postgresql" else str(value)

    def process_result_value(self, value: Any, dialect) -> uuid.UUID | None:
        if value is None:
            return None
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


# JSONB gives PostgreSQL indexable, deduplicated storage; MySQL 5.7+ and
# MariaDB 10.2+ have their own native JSON column type, which this dialect
# variant reaches automatically; SQLite falls back to plain JSON (text).
JSONType = JSON().with_variant(JSONB(), "postgresql")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)

    # PostgreSQL has citext, SQLite does not. Rather than depend on an
    # extension, emails are lowercased on the way in (see normalise_email) and
    # a plain unique index then gives case-insensitive uniqueness on both.
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    company: Mapped[str] = mapped_column(String(200), nullable=False, default="—")

    # Deliberately not an enum: promoting a user is an out-of-band UPDATE, and
    # a CHECK-backed enum would require a migration to add a future role.
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="customer", server_default="customer")

    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    events: Mapped[list["UsageEvent"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<User {self.email} role={self.role} active={self.active}>"


class UsageEvent(Base):
    """One row per tracked action: signup, login, logout, scan, health, export.

    Endpoints for this arrive in a later phase; the table is here so events can
    start accumulating as soon as they do.
    """

    __tablename__ = "usage_events"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False, default=dict, server_default="{}")
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="events")

    # Both admin views this anticipates - one user's timeline, and one event
    # type across all users - are range scans ordered by time descending.
    __table_args__ = (
        Index("ix_usage_events_user_ts", "user_id", ts.desc()),
        Index("ix_usage_events_type_ts", "type", ts.desc()),
    )
