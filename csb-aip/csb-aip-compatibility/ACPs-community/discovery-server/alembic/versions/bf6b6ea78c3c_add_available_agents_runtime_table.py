"""add available agents runtime table

Revision ID: bf6b6ea78c3c
Revises: 865c8015dad7
Create Date: 2026-04-29 23:40:00.000000

"""

from __future__ import annotations

from typing import TYPE_CHECKING

import sqlalchemy as sa

from alembic import op

if TYPE_CHECKING:
    from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "bf6b6ea78c3c"
down_revision: str | Sequence[str] | None = "865c8015dad7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        CREATE UNLOGGED TABLE available_agents_runtime (
            aic TEXT PRIMARY KEY,
            is_available BOOLEAN NOT NULL DEFAULT FALSE,
            checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.create_index(
        "idx_available_agents_runtime_available",
        "available_agents_runtime",
        ["aic"],
        unique=False,
        postgresql_where=sa.text("is_available = TRUE"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "idx_available_agents_runtime_available",
        table_name="available_agents_runtime",
    )
    op.drop_table("available_agents_runtime")
