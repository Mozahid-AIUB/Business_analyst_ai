"""Application settings, read from the environment.

Local development runs with zero setup: the defaults below point at a SQLite
file and a throwaway signing key. Anything that would be unsafe to ship is
checked in `validate_for_environment`, which is called at startup rather than
at import time so that tooling (alembic, pytest collection) can import this
module without tripping over production rules.
"""
from __future__ import annotations

import secrets
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Generated once per process. A restart invalidates every outstanding token,
# which is correct for a dev box and catastrophic in production - hence the
# hard check in validate_for_environment().
_DEV_FALLBACK_SECRET = secrets.token_urlsafe(48)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: Literal["development", "staging", "production"] = "development"

    # Empty rather than a real-looking placeholder: a committed default is a
    # committed secret, and one that looks plausible is worse than none.
    secret_key: str = ""
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    # Long enough that a daily user is never forced to retype a password,
    # short enough that a stolen refresh token expires within a sprint.
    refresh_token_expire_days: int = 14

    database_url: str = "sqlite:///./sentinel.db"

    # The static frontend is opened straight from disk during development,
    # which sends Origin: null. That is only tolerated outside production.
    cors_origins: str = "http://localhost:8000,http://127.0.0.1:8000,http://localhost:5500,http://127.0.0.1:5500"

    login_rate_limit_attempts: int = 5
    login_rate_limit_window_seconds: int = 300

    @field_validator("cors_origins")
    @classmethod
    def _strip_origins(cls, v: str) -> str:
        return v.strip()

    @property
    def cors_origin_list(self) -> list[str]:
        """CORS origins as a list.

        `allow_credentials=True` forbids the "*" wildcard, so an explicit list
        is the only configuration that actually works with cookie or
        Authorization-bearing requests.
        """
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def effective_secret_key(self) -> str:
        return self.secret_key or _DEV_FALLBACK_SECRET

    def validate_for_environment(self) -> None:
        """Fail loudly rather than start up quietly insecure."""
        if self.is_production:
            if not self.secret_key:
                raise RuntimeError(
                    "SECRET_KEY is unset while ENVIRONMENT=production. "
                    "Generate one with: openssl rand -hex 32"
                )
            if len(self.secret_key) < 32:
                raise RuntimeError(
                    "SECRET_KEY is too short (<32 chars) for production. "
                    "Generate one with: openssl rand -hex 32"
                )
            if self.database_url.startswith("sqlite"):
                raise RuntimeError(
                    "SQLite is not supported in production. Point DATABASE_URL "
                    "at PostgreSQL or MySQL."
                )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
