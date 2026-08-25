# syntax=docker/dockerfile:1.7

ARG PYTHON_IMAGE=python:3.14.3-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.21

FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE} AS builder

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /build
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_CACHE_DIR=/root/.cache/uv

COPY pyproject.toml uv.lock ./

RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-dev --no-install-project

FROM ${PYTHON_IMAGE} AS runtime

ARG VERSION=0.0.0
ARG SHORT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="ca-server" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.revision="${SHORT_SHA}" \
    org.opencontainers.image.created="${BUILD_DATE}"

RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini ./

RUN mkdir -p /app/logs /app/certs \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 9003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:9003/health')"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 9003 --log-level ${UVICORN_LOG_LEVEL:-info}"]
