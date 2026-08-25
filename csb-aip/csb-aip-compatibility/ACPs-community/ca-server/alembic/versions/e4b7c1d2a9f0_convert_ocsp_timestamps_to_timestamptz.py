"""convert ocsp timestamps to timestamptz

Revision ID: e4b7c1d2a9f0
Revises: d9f2a6c4b1e8
Create Date: 2026-04-26 02:10:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e4b7c1d2a9f0"
down_revision: str | None = "d9f2a6c4b1e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OCSP_REQUEST_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (("created_at", False),)

_OCSP_RESPONSE_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("this_update", False),
    ("next_update", True),
    ("revocation_time", True),
    ("created_at", False),
)

_OCSP_RESPONDER_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("created_at", False),
    ("updated_at", False),
)


def upgrade() -> None:
    """Upgrade schema."""
    for column_name, nullable in _OCSP_REQUEST_TIME_COLUMNS:
        op.alter_column(
            "ocsp_requests",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _OCSP_RESPONSE_TIME_COLUMNS:
        op.alter_column(
            "ocsp_responses",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _OCSP_RESPONDER_TIME_COLUMNS:
        op.alter_column(
            "ocsp_responders",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )


def downgrade() -> None:
    """Downgrade schema."""
    for column_name, nullable in _OCSP_RESPONDER_TIME_COLUMNS:
        op.alter_column(
            "ocsp_responders",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _OCSP_RESPONSE_TIME_COLUMNS:
        op.alter_column(
            "ocsp_responses",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _OCSP_REQUEST_TIME_COLUMNS:
        op.alter_column(
            "ocsp_requests",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )
