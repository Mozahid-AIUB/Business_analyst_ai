"""SQLAlchemy 2.x engine, session factory and the FastAPI session dependency.

SQLite is the default so the backend runs with no services installed. Moving
to PostgreSQL is a DATABASE_URL change and nothing else - the only
driver-specific code is the connect-args block below.
"""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def _engine_kwargs(url: str) -> dict:
    if url.startswith("sqlite"):
        # SQLite pins a connection to the creating thread by default, which
        # breaks FastAPI's threadpool for sync endpoints.
        return {"connect_args": {"check_same_thread": False}}
    # pool_pre_ping costs one round trip but avoids handing out connections
    # that a pgbouncer restart or idle timeout has already closed.
    return {"pool_pre_ping": True, "pool_size": 5, "max_overflow": 10}


engine = create_engine(settings.database_url, **_engine_kwargs(settings.database_url))

SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """Request-scoped session. Rolls back on an exception so a failed request
    never leaves a partial write visible to the next one."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db() -> None:
    """Create tables that do not yet exist.

    Adequate for SQLite development and a first PostgreSQL deploy. A schema
    that must evolve without data loss needs Alembic - see README.
    """
    from . import models  # noqa: F401  - registers mappers on Base.metadata

    Base.metadata.create_all(bind=engine)
