"""create webhook table if missing

Revision ID: 949816878987
Revises: e24d8c3b7f11
Create Date: 2026-04-24 15:43:43.054672

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "949816878987"
down_revision: str | None = "e24d8c3b7f11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WEBHOOK_INDEXES: tuple[tuple[str, list[str]], ...] = (
    ("ix_webhook_id", ["id"]),
    ("ix_webhook_url", ["url"]),
    ("ix_webhook_types", ["types"]),
    ("ix_webhook_events", ["events"]),
    ("ix_webhook_status", ["status"]),
)


def upgrade() -> None:
    """Create webhook table when upgrading a database that never had it."""

    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "webhook" not in inspector.get_table_names():
        op.create_table(
            "webhook",
            sa.Column("id", sa.String(length=50), nullable=False),
            sa.Column("url", sa.String(length=2000), nullable=False),
            sa.Column("secret", sa.String(length=500), nullable=False),
            sa.Column("types", sa.String(length=255), nullable=False),
            sa.Column("events", sa.String(length=255), nullable=False),
            sa.Column("description", sa.String(length=500), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
            sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("next_retry_at", sa.TIMESTAMP(timezone=True), nullable=True),
            sa.Column("last_triggered_at", sa.TIMESTAMP(timezone=True), nullable=True),
            sa.Column("last_success_at", sa.TIMESTAMP(timezone=True), nullable=True),
            sa.Column("last_failure_at", sa.TIMESTAMP(timezone=True), nullable=True),
            sa.Column("last_failure_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False),
            sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        inspector = sa.inspect(bind)

    existing_indexes = {index["name"] for index in inspector.get_indexes("webhook")}
    for index_name, columns in WEBHOOK_INDEXES:
        if index_name not in existing_indexes:
            op.create_index(index_name, "webhook", columns, unique=False)


def downgrade() -> None:
    """Drop webhook table when rolling back this corrective migration."""

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "webhook" in inspector.get_table_names():
        op.drop_table("webhook")
