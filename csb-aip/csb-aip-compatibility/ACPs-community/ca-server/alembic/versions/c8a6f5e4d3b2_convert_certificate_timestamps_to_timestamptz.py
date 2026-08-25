"""convert certificate timestamps to timestamptz

Revision ID: c8a6f5e4d3b2
Revises: f3c2d1a4b5e6
Create Date: 2026-04-26 00:55:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c8a6f5e4d3b2"
down_revision: str | None = "f3c2d1a4b5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CERTIFICATE_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("issued_at", False),
    ("expires_at", False),
    ("revoked_at", True),
    ("created_at", False),
    ("updated_at", False),
)


def upgrade() -> None:
    """Upgrade schema."""
    for column_name, nullable in _CERTIFICATE_TIME_COLUMNS:
        op.alter_column(
            "certificates",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )


def downgrade() -> None:
    """Downgrade schema."""
    for column_name, nullable in _CERTIFICATE_TIME_COLUMNS:
        op.alter_column(
            "certificates",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )
