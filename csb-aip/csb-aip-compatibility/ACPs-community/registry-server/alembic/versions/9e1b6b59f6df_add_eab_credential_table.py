"""add_eab_credential_table

Revision ID: 9e1b6b59f6df
Revises: b0f1a2c3d4e5
Create Date: 2026-04-11 15:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9e1b6b59f6df"
down_revision: str | None = "b0f1a2c3d4e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "eab_credential",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("key_id", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column(
            "mac_key_encrypted",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
        ),
        sa.Column("aic", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("is_consumed", sa.Boolean(), nullable=False),
        sa.Column("consumed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["account_user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_eab_credential_id"), "eab_credential", ["id"], unique=False)
    op.create_index(
        op.f("ix_eab_credential_key_id"),
        "eab_credential",
        ["key_id"],
        unique=True,
    )
    op.create_index(op.f("ix_eab_credential_aic"), "eab_credential", ["aic"], unique=False)
    op.create_index(
        op.f("ix_eab_credential_user_id"),
        "eab_credential",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_eab_credential_user_id"), table_name="eab_credential")
    op.drop_index(op.f("ix_eab_credential_aic"), table_name="eab_credential")
    op.drop_index(op.f("ix_eab_credential_key_id"), table_name="eab_credential")
    op.drop_index(op.f("ix_eab_credential_id"), table_name="eab_credential")
    op.drop_table("eab_credential")
