#!/usr/bin/env python3
"""Ensure the pgvector extension is available in the target database."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import click
import psycopg2
from dotenv import dotenv_values
from psycopg2 import OperationalError, sql
from psycopg2.errors import FeatureNotSupported, InsufficientPrivilege, UndefinedFile
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
from sqlalchemy.engine import make_url

DEFAULT_DATABASE_ADMIN_URL = "postgresql://postgres:devpass@localhost:5432/postgres"


def resolve_database_url_from_env(env_name: str) -> str:
    """Resolve a database URL from process env first, then local .env."""

    env_value = os.getenv(env_name, "").strip()
    if env_value:
        return env_value

    env_path = Path(".env")
    if env_path.is_file():
        dot_env_value = dotenv_values(env_path).get(env_name)
        if isinstance(dot_env_value, str) and dot_env_value.strip():
            return dot_env_value.strip()

    return ""


def _build_connection_kwargs(database_url: str, *, override_database: str | None = None) -> dict[str, Any]:
    url = make_url(database_url)
    database_name = override_database or url.database

    if not database_name:
        raise click.ClickException("目标数据库 URL 缺少数据库名。")
    if not url.username:
        raise click.ClickException("数据库 URL 缺少用户名。")

    return {
        "host": url.host or "localhost",
        "port": url.port or 5432,
        "user": url.username,
        "password": url.password,
        "dbname": database_name,
    }


def extension_exists(*, database_url: str, extension_name: str) -> bool:
    try:
        connection = psycopg2.connect(**_build_connection_kwargs(database_url))
    except OperationalError as exc:
        raise click.ClickException(
            "无法连接目标数据库以检查 pgvector 扩展；请确认 DATABASE_URL/TEST_DATABASE_URL 指向的数据库已存在且可访问。"
        ) from exc

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_extension WHERE extname = %s", (extension_name,))
            return cursor.fetchone() is not None
    finally:
        connection.close()


def ensure_extension_available(
    *,
    target_database_url: str,
    admin_database_url: str,
    extension_name: str,
    target_label: str,
    admin_label: str,
) -> bool:
    """Ensure the extension exists, creating it with the admin connection when needed."""

    if extension_exists(database_url=target_database_url, extension_name=extension_name):
        return False

    target_database_name = make_url(target_database_url).database
    if not target_database_name:
        raise click.ClickException(f"{target_label} 缺少数据库名。")

    try:
        admin_connection = psycopg2.connect(
            **_build_connection_kwargs(admin_database_url, override_database=target_database_name)
        )
    except OperationalError as exc:
        raise click.ClickException(
            f"无法通过 {admin_label} 连接到目标数据库；请确认管理员连接串正确，或先由数据库管理员手工创建 vector 扩展。"
        ) from exc

    admin_connection.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)

    try:
        with admin_connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE EXTENSION IF NOT EXISTS {}").format(sql.Identifier(extension_name)))
    except (FeatureNotSupported, UndefinedFile) as exc:
        raise click.ClickException(
            "当前 PostgreSQL 实例未提供 pgvector 扩展，"
            "请重建 shared dev-infra 的 postgres 容器或在目标机安装 pgvector。"
        ) from exc
    except InsufficientPrivilege as exc:
        raise click.ClickException(
            f"{admin_label} 无法创建扩展 {extension_name}；"
            "请改用具备超级用户/足够权限的 PostgreSQL 管理账号，"
            f"或先手工在目标库执行 CREATE EXTENSION IF NOT EXISTS {extension_name}。"
        ) from exc
    finally:
        admin_connection.close()

    if not extension_exists(database_url=target_database_url, extension_name=extension_name):
        raise click.ClickException(
            f"已尝试通过 {admin_label} 创建扩展 {extension_name}，但 {target_label} 中仍未检测到该扩展。"
        )

    return True


@click.command()
@click.option("--database-url-env", default="DATABASE_URL", show_default=True, help="目标数据库 URL 对应的环境变量名。")
@click.option(
    "--admin-url-env",
    default="DATABASE_ADMIN_URL",
    show_default=True,
    help="管理员数据库 URL 对应的环境变量名；未设置时回退到 shared dev-infra 默认 postgres 账号。",
)
@click.option("--extension", default="vector", show_default=True, help="需要确保存在的 PostgreSQL 扩展名。")
def main(database_url_env: str, admin_url_env: str, extension: str) -> int:
    target_database_url = resolve_database_url_from_env(database_url_env)
    if not target_database_url:
        raise click.ClickException(f"未配置 {database_url_env}，无法确保 {extension} 扩展可用。")

    admin_database_url = resolve_database_url_from_env(admin_url_env) or DEFAULT_DATABASE_ADMIN_URL
    created = ensure_extension_available(
        target_database_url=target_database_url,
        admin_database_url=admin_database_url,
        extension_name=extension,
        target_label=database_url_env,
        admin_label=admin_url_env,
    )

    if created:
        click.echo(f"[INFO] 已确保数据库扩展可用：{extension}")
    else:
        click.echo(f"[INFO] 数据库扩展已存在：{extension}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
