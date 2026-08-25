# syntax=docker/dockerfile:1.7

# ---- Builder 阶段 ----
ARG PYTHON_IMAGE=python:3.14.3-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.21

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS builder

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /build/demo-partner
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_CACHE_DIR=/root/.cache/uv

COPY pyproject.toml uv.lock ./
COPY --from=acps_sdk . /build/acps-sdk
COPY --from=acps_cli . /build/acps-cli
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-dev --no-install-project --no-editable

# ---- Runtime 阶段 ----
FROM ${PYTHON_IMAGE} AS runtime

ARG VERSION=0.0.0
ARG SHORT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="demo-partner" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.revision="${SHORT_SHA}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.source="https://github.com/acps/demo-partner"

RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY partners/ ./partners/

RUN mkdir -p /app/logs \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 9021 9022 9023 9024 9025

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import socket; [socket.create_connection(('localhost', port), timeout=5).close() for port in (9021, 9022, 9023, 9024, 9025)]"

CMD ["python", "-m", "partners.main"]
