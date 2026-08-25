"""convert acme timestamps to timestamptz

Revision ID: f6a8b9c0d1e2
Revises: e4b7c1d2a9f0
Create Date: 2026-04-26 02:15:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f6a8b9c0d1e2"
down_revision: str | None = "e4b7c1d2a9f0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ACCOUNT_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("created_at", False),
    ("updated_at", True),
)

_ORDER_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("not_before", True),
    ("not_after", True),
    ("created_at", False),
    ("updated_at", True),
    ("expires", False),
)

_AUTHORIZATION_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("expires", False),
    ("created_at", False),
    ("updated_at", True),
)

_CHALLENGE_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("validated", True),
    ("created_at", False),
    ("updated_at", True),
)

_CERTIFICATE_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("not_before", False),
    ("not_after", False),
    ("revoked_at", True),
    ("created_at", False),
    ("updated_at", True),
)

_NONCE_TIME_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("expires", False),
    ("created_at", False),
)


def upgrade() -> None:
    """Upgrade schema."""
    for column_name, nullable in _ACCOUNT_TIME_COLUMNS:
        op.alter_column(
            "acme_accounts",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _ORDER_TIME_COLUMNS:
        op.alter_column(
            "acme_orders",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _AUTHORIZATION_TIME_COLUMNS:
        op.alter_column(
            "acme_authorizations",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _CHALLENGE_TIME_COLUMNS:
        op.alter_column(
            "acme_challenges",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _CERTIFICATE_TIME_COLUMNS:
        op.alter_column(
            "acme_certificates",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _NONCE_TIME_COLUMNS:
        op.alter_column(
            "acme_nonces",
            column_name,
            existing_type=sa.DateTime(),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )


def downgrade() -> None:
    """Downgrade schema."""
    for column_name, nullable in _NONCE_TIME_COLUMNS:
        op.alter_column(
            "acme_nonces",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _CERTIFICATE_TIME_COLUMNS:
        op.alter_column(
            "acme_certificates",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _CHALLENGE_TIME_COLUMNS:
        op.alter_column(
            "acme_challenges",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _AUTHORIZATION_TIME_COLUMNS:
        op.alter_column(
            "acme_authorizations",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _ORDER_TIME_COLUMNS:
        op.alter_column(
            "acme_orders",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )

    for column_name, nullable in _ACCOUNT_TIME_COLUMNS:
        op.alter_column(
            "acme_accounts",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'Asia/Shanghai'",
        )
