"""Test fixtures: an isolated database per test and a client wired to it."""
from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from pathlib import Path

# Set before app.config is imported, so Settings picks these up rather than a
# developer's real .env sitting next to the tests.
os.environ["ENVIRONMENT"] = "development"
os.environ["SECRET_KEY"] = "test-only-key-not-used-outside-pytest-0123456789abcdef"
os.environ["DATABASE_URL"] = "sqlite://"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import Depends  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, event  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.database import Base, get_db  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402
from app.models import User  # noqa: E402
from app.security import login_rate_limiter, require_admin  # noqa: E402


@pytest.fixture
def engine():
    """In-memory SQLite, one shared connection.

    StaticPool is required: the default pool would give each connection its own
    private in-memory database, so the request and the assertions would not see
    the same rows.
    """
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    # SQLite ignores foreign keys unless asked, which would let the UsageEvent
    # cascade pass here and fail on PostgreSQL.
    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(bind=eng)
    try:
        yield eng
    finally:
        Base.metadata.drop_all(bind=eng)
        eng.dispose()


@pytest.fixture
def db_session(engine) -> Iterator[Session]:
    """A session for arranging state and asserting on it, separate from the
    sessions the endpoints use."""
    factory = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine) -> Iterator[TestClient]:
    factory = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Iterator[Session]:
        db = factory()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    # The limiter is process-global; without this a test that exhausts it would
    # make every later login test fail.
    login_rate_limiter.clear()

    fastapi_app.dependency_overrides[get_db] = override_get_db

    # require_admin is a dependency, not a route, so it needs a route to be
    # exercised through. Mounted here rather than in the app so the production
    # surface stays exactly the seven documented endpoints.
    if not any(getattr(r, "path", None) == "/test-only/admin-area" for r in fastapi_app.routes):

        @fastapi_app.get("/test-only/admin-area")
        def _admin_area(admin: User = Depends(require_admin)) -> dict[str, str]:
            return {"ok": admin.email}

    try:
        # Startup would otherwise run init_db() against the real DATABASE_URL
        # engine; the schema here is already created by the engine fixture.
        with TestClient(fastapi_app) as c:
            yield c
    finally:
        fastapi_app.dependency_overrides.clear()
        login_rate_limiter.clear()
