#!/usr/bin/env python3
"""确保测试数据库存在。"""

from __future__ import annotations

import click
import psycopg2
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
from sqlalchemy.engine import make_url

from scripts.ensure_vector_extension import (
    DEFAULT_DATABASE_ADMIN_URL,
    ensure_extension_available,
    resolve_database_url_from_env,
)


def main() -> int:
    database_url = resolve_database_url_from_env("TEST_DATABASE_URL")
    if not database_url:
        click.echo("[ERROR] 未配置 TEST_DATABASE_URL，无法确保测试数据库存在。", err=True)
        return 1

    url = make_url(database_url)
    database_name = url.database
    if not database_name:
        click.echo("[ERROR] TEST_DATABASE_URL 缺少数据库名。", err=True)
        return 1

    owner_name = url.username
    if not owner_name:
        click.echo("[ERROR] TEST_DATABASE_URL 缺少数据库用户名。", err=True)
        return 1

    admin_database_url = resolve_database_url_from_env("TEST_DATABASE_ADMIN_URL") or DEFAULT_DATABASE_ADMIN_URL
    admin_url = make_url(admin_database_url)

    connection = psycopg2.connect(
        host=admin_url.host or "localhost",
        port=admin_url.port or 5432,
        user=admin_url.username,
        password=admin_url.password,
        dbname=admin_url.database or "postgres",
    )
    connection.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database_name,))
            exists = cursor.fetchone() is not None
            if not exists:
                cursor.execute(
                    sql.SQL("CREATE DATABASE {} OWNER {}").format(
                        sql.Identifier(database_name),
                        sql.Identifier(owner_name),
                    )
                )
                click.echo(f"[INFO] 已创建测试数据库：{database_name}")
    finally:
        connection.close()

    ensure_extension_available(
        target_database_url=database_url,
        admin_database_url=admin_database_url,
        extension_name="vector",
        target_label="TEST_DATABASE_URL",
        admin_label="TEST_DATABASE_ADMIN_URL",
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
