# syntax=docker/dockerfile:1.7

ARG PYTHON_IMAGE=python:3.14.3-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.21
ARG DISCOVERY_BUILD_PROFILE=cpu

FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE} AS builder

ARG DISCOVERY_BUILD_PROFILE
COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /build/discovery-server
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/root/.cache/uv

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# 通过 build context 引入 sibling 项目，满足本地 acps-sdk 路径依赖。
COPY --from=acps_sdk . /build/acps-sdk

COPY pyproject.toml uv.lock ./
COPY scripts/release-app/cpu-build-manifest/ ./scripts/release-app/cpu-build-manifest/

RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    if [ "${DISCOVERY_BUILD_PROFILE}" = "cpu" ]; then \
    uv sync --project scripts/release-app/cpu-build-manifest --frozen --no-dev --no-install-project --no-editable; \
    elif [ "${DISCOVERY_BUILD_PROFILE}" = "gpu" ]; then \
    uv sync --frozen --no-dev --no-install-project --no-editable; \
    else \
    echo "Unsupported DISCOVERY_BUILD_PROFILE: ${DISCOVERY_BUILD_PROFILE}" >&2; \
    exit 1; \
    fi \
    && tar --hard-dereference -cf /tmp/venv.tar -C / opt/venv

FROM ${PYTHON_IMAGE} AS runtime

ARG VERSION=0.0.0
ARG SHORT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="discovery-server" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.revision="${SHORT_SHA}" \
    org.opencontainers.image.created="${BUILD_DATE}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

COPY --from=builder /tmp/venv.tar /tmp/venv.tar
RUN tar -xf /tmp/venv.tar -C / \
    && rm /tmp/venv.tar

ENV PATH="/opt/venv/bin:$PATH"

COPY app/ ./app/
COPY config/ ./config/
COPY alembic/ ./alembic/
COPY alembic.ini ./
COPY main.py ./
COPY scripts/prompts/ ./scripts/prompts/

RUN mkdir -p /app/logs \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 9005

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:9005/health')"

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 9005 --log-level ${UVICORN_LOG_LEVEL:-info}"]
