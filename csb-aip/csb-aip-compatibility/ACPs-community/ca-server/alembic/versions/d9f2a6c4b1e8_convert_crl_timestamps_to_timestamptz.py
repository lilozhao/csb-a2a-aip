"""convert crl timestamps to timestamptz

Revision ID: d9f2a6c4b1e8
Revises: c8a6f5e4d3b2
Create Date: 2026-04-26 02:05:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d9f2a6c4b1e8"
down_revision: str | None = "c8a6f5e4d3b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CRL_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("this_update", False),
    ("next_update", False),
    ("created_at", False),
)

_REVOKED_ENTRY_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("revocation_date", False),
    ("created_at", False),
)


def upgrade() -> None:
    """Upgrade schema."""
    for column_name, nullable in _CRL_TIME_COLUMNS:
        op.alter_column(
            "certificate_revocation_lists",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _REVOKED_ENTRY_TIME_COLUMNS:
        op.alter_column(
            "revoked_certificate_entries",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )


def downgrade() -> None:
    """Downgrade schema."""
    for column_name, nullable in _REVOKED_ENTRY_TIME_COLUMNS:
        op.alter_column(
            "revoked_certificate_entries",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _CRL_TIME_COLUMNS:
        op.alter_column(
            "certificate_revocation_lists",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )
