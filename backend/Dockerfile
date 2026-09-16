# syntax=docker/dockerfile:1

FROM python:3.12-slim AS base

# PYTHONDONTWRITEBYTECODE: the image layer is read-only anyway, .pyc files are
# dead weight. PYTHONUNBUFFERED: without it, logs sit in a buffer and a crash
# loses the lines that explain it.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Requirements first, as their own layer: application edits then rebuild in
# seconds instead of reinstalling the dependency tree every time.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Non-root. A container process that does not need to write to its own image
# should not be able to.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status==200 else 1)"

# Single worker on purpose: the login rate limiter keeps its counters in
# process memory, so additional workers would each enforce their own limit.
# Move that state to Redis before raising --workers. See app/security.py.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
