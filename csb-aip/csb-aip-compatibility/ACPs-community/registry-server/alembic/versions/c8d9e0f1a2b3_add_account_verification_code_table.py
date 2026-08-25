"""add account verification code table

Revision ID: c8d9e0f1a2b3
Revises: 949816878987
Create Date: 2026-04-25 18:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c8d9e0f1a2b3"
down_revision: str | None = "949816878987"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the account verification code table."""

    op.create_table(
        "account_verification_code",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("phone", sqlmodel.sql.sqltypes.AutoString(length=20), nullable=False),
        sa.Column("code", sqlmodel.sql.sqltypes.AutoString(length=10), nullable=False),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_account_verification_code_id"),
        "account_verification_code",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_account_verification_code_phone"),
        "account_verification_code",
        ["phone"],
        unique=True,
    )


def downgrade() -> None:
    """Drop the account verification code table."""

    op.drop_index(op.f("ix_account_verification_code_phone"), table_name="account_verification_code")
    op.drop_index(op.f("ix_account_verification_code_id"), table_name="account_verification_code")
    op.drop_table("account_verification_code")
