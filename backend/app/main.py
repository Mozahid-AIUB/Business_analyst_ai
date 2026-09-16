"""FastAPI application entry point.

Scope: authentication and accounts. There is deliberately no scoring endpoint -
the ML models run in the browser so customer transaction CSVs never touch this
server, which keeps the product out of PCI DSS scope. See backend/README.md.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import init_db
from .routers import auth


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Validated at startup rather than import time so a missing SECRET_KEY in
    # production stops the process immediately and visibly, instead of the
    # server coming up and signing tokens with a throwaway dev key.
    settings.validate_for_environment()
    init_db()
    yield


app = FastAPI(
    title="Sentinel Risk Desk - Auth API",
    description=(
        "Accounts and sessions for Sentinel Risk Desk. Scoring is not served "
        "here: the models run client-side so customer data never leaves the "
        "browser."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    # Credentials are on because the frontend sends an Authorization header;
    # this is also why the origin list is explicit and never "*".
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth.router)


@app.get("/health", tags=["meta"], summary="Liveness probe")
async def health() -> dict[str, str]:
    """Deliberately does not touch the database: this answers "is the process
    up", which is what a load balancer needs. A readiness check that verifies
    the database belongs on a separate path."""
    return {"status": "ok", "environment": settings.environment}
