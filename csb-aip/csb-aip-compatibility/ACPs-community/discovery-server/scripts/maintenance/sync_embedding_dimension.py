#!/usr/bin/env python3
"""一次性工具，用于将skills.embedding维度与EMBEDDING_DIM对齐"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass

import click
from sqlalchemy import create_engine, text

from app.core.config import settings


@dataclass
class SyncResult:
    changed: bool
    old_dim: int
    new_dim: int
    non_null_vectors: int


def to_sync_database_url(database_url: str) -> str:
    """Convert async SQLAlchemy URL to sync URL for one-off maintenance scripts."""
    if database_url.startswith("postgresql+asyncpg://"):
        return database_url.replace("postgresql+asyncpg://", "postgresql+psycopg2://", 1)
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg2://", 1)
    raise ValueError("Only PostgreSQL URLs are supported. Please check DATABASE_URL in .env")


def parse_vector_dim(type_repr: str) -> int:
    match = re.fullmatch(r"vector\((\d+)\)", type_repr.strip())
    if not match:
        raise ValueError(f"Unexpected embedding column type: {type_repr}")
    return int(match.group(1))


def sync_embedding_dimension(target_dim: int, force_clear: bool = False) -> SyncResult:
    if target_dim <= 0:
        raise ValueError("EMBEDDING_DIM must be a positive integer")

    sync_url = to_sync_database_url(settings.DATABASE_URL)
    engine = create_engine(sync_url, future=True)

    with engine.begin() as conn:
        table_exists = conn.execute(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = current_schema()
                      AND table_name = 'skills'
                )
                """
            )
        ).scalar_one()

        if not table_exists:
            raise RuntimeError("Table skills does not exist. Please run alembic upgrade head first.")

        type_repr = conn.execute(
            text(
                """
                SELECT format_type(a.atttypid, a.atttypmod)
                FROM pg_attribute a
                JOIN pg_class c ON a.attrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE n.nspname = current_schema()
                  AND c.relname = 'skills'
                  AND a.attname = 'embedding'
                  AND a.attnum > 0
                  AND NOT a.attisdropped
                """
            )
        ).scalar_one_or_none()

        if type_repr is None:
            raise RuntimeError("Column skills.embedding not found")

        current_dim = parse_vector_dim(type_repr)
        non_null_vectors = conn.execute(text("SELECT COUNT(*) FROM skills WHERE embedding IS NOT NULL")).scalar_one()

        if current_dim == target_dim:
            return SyncResult(
                changed=False,
                old_dim=current_dim,
                new_dim=target_dim,
                non_null_vectors=non_null_vectors,
            )

        if non_null_vectors > 0 and not force_clear:
            raise RuntimeError(
                "Dimension mismatch detected and existing vectors found. "
                "Re-run with --force-clear to clear all local data before altering dimension."
            )

        if force_clear:
            # 清空 agents，依赖 FK ON DELETE CASCADE 联动清空 skills。
            conn.execute(text("DELETE FROM agents"))
            non_null_vectors = 0

        conn.execute(text("DROP INDEX IF EXISTS skills_embedding_hnsw_idx"))

        conn.execute(
            text(
                f"ALTER TABLE skills ALTER COLUMN embedding TYPE vector({target_dim}) USING NULL::vector({target_dim})"
            )
        )

        conn.execute(
            text(
                """
                CREATE INDEX IF NOT EXISTS skills_embedding_hnsw_idx
                ON skills USING hnsw (embedding vector_cosine_ops)
                WITH (m = 16, ef_construction = 64)
                """
            )
        )

        return SyncResult(
            changed=True,
            old_dim=current_dim,
            new_dim=target_dim,
            non_null_vectors=non_null_vectors,
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Sync skills.embedding vector dimension to EMBEDDING_DIM. "
            "Run this after alembic migration and before starting the service."
        )
    )
    parser.add_argument(
        "--dim",
        type=int,
        default=settings.EMBEDDING_DIM,
        help="Target vector dimension. Defaults to EMBEDDING_DIM.",
    )
    parser.add_argument(
        "--force-clear",
        action="store_true",
        help="Allow clearing all local agents/skills data when dimension changes.",
    )
    args = parser.parse_args()

    try:
        result = sync_embedding_dimension(target_dim=args.dim, force_clear=args.force_clear)
    except Exception as exc:
        click.echo(f"[ERROR] {exc}", err=True)
        return 1

    if result.changed:
        click.echo(
            "[OK] skills.embedding dimension updated "
            f"{result.old_dim} -> {result.new_dim}. "
            f"Existing non-null vectors before migration: {result.non_null_vectors}."
        )
    else:
        click.echo(f"[OK] skills.embedding dimension already aligned at {result.new_dim}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
