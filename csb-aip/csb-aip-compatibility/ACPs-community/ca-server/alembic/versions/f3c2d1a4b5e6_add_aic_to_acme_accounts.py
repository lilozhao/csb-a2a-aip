"""add aic to acme accounts

Revision ID: f3c2d1a4b5e6
Revises: 9b3d2b7c1a6f
Create Date: 2026-04-11 16:10:00

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3c2d1a4b5e6"
down_revision: str | None = "9b3d2b7c1a6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "acme_accounts",
        sa.Column("aic", sa.String(length=255), nullable=True),
    )
    op.create_index(op.f("ix_acme_accounts_aic"), "acme_accounts", ["aic"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_acme_accounts_aic"), table_name="acme_accounts")
    op.drop_column("acme_accounts", "aic")
