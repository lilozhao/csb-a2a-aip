#!/usr/bin/env python3
"""只读检查测试数据库连通性和 Alembic schema 状态。"""

from __future__ import annotations

import os

import click
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError


def to_sync_database_url(database_url: str) -> str:
    """将测试数据库 URL 规范化为同步驱动，便于脚本做只读预检。"""
    if database_url.startswith("postgresql+asyncpg://"):
        return database_url.replace("postgresql+asyncpg://", "postgresql+psycopg2://", 1)
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg2://", 1)
    if database_url.startswith("postgresql+psycopg2://"):
        return database_url
    raise ValueError("TEST_DATABASE_URL 必须是 PostgreSQL URL")


def main() -> int:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        click.echo("[ERROR] 未配置 TEST_DATABASE_URL，请先执行 just test bootstrap。", err=True)
        return 1

    engine = None
    try:
        engine = create_engine(to_sync_database_url(database_url), pool_pre_ping=True, future=True)
        with engine.connect() as connection:
            revision = connection.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).scalar_one_or_none()
    except (SQLAlchemyError, ValueError) as exc:
        click.echo(
            "[ERROR] 测试数据库预检失败：无法确认连接和 schema 已就绪，请先执行 just test bootstrap。",
            err=True,
        )
        click.echo(f"[ERROR] 详细原因: {exc}", err=True)
        return 1
    finally:
        if engine is not None:
            engine.dispose()

    if not revision:
        click.echo("[ERROR] 测试数据库预检失败：alembic_version 无记录，请先执行 just test bootstrap。", err=True)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
