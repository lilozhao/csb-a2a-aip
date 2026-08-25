# syntax=docker/dockerfile:1.7

# ============================================================
# 多阶段构建 Dockerfile
# 阶段1: builder — 用 uv sync 安装依赖到独立虚拟环境
# 阶段2: runtime — 最小镜像，仅复制运行时需要的文件
# ============================================================

# ---- Builder 阶段 ----
ARG PYTHON_IMAGE=python:3.14.3-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.21

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS builder

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /build
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_CACHE_DIR=/root/.cache/uv

# 先复制依赖声明以利用缓存
COPY pyproject.toml uv.lock ./

# 使用 uv sync 安装依赖（先 no-install-project 利用缓存，再 COPY 源码后安装项目本体）
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-dev --no-install-project

COPY README.md ./README.md
COPY app/ ./app/
RUN --mount=type=cache,target=/root/.cache/uv,sharing=locked \
    uv sync --frozen --no-dev --no-editable

# ---- Runtime 阶段 ----
FROM ${PYTHON_IMAGE} AS runtime

ARG VERSION=0.0.0
ARG SHORT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="mq-auth-server" \
    org.opencontainers.image.version="${VERSION}" \
    org.opencontainers.image.revision="${SHORT_SHA}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.source="https://gitlab.example.com/acps/mq-auth-server"

# 安全：非 root 用户
RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --shell /bin/bash --create-home appuser

WORKDIR /app

# 从 builder 复制虚拟环境（不含 uv、pip 等构建工具）
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 仅复制运行时需要的文件
COPY app/ ./app/
COPY config/ ./config/

# 创建日志目录
RUN mkdir -p /app/logs && chown -R appuser:appuser /app

USER appuser

EXPOSE 9007 9008

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -m app.core.health_probe --url https://localhost:9007/health

CMD ["mq-auth-server"]
