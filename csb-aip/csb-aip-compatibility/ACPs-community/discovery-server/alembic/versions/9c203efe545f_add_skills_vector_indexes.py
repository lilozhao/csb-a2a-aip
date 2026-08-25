"""add skills vector indexes

Revision ID: 9c203efe545f
Revises: 7a28c73afbe8
Create Date: 2025-12-24 09:58:47.610430

"""

from __future__ import annotations

from typing import TYPE_CHECKING

from alembic import op

if TYPE_CHECKING:
    from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "9c203efe545f"
down_revision: str | Sequence[str] | None = "7a28c73afbe8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "skills_embedding_hnsw_idx",
        "skills",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )

    # GIN 稀疏向量索引
    op.create_index(
        "skills_sparse_embedding_gin_idx",
        "skills",
        ["sparse_embedding"],
        postgresql_using="gin",
        postgresql_ops={"sparse_embedding": "jsonb_path_ops"},
    )
    pass


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("skills_embedding_hnsw_idx", table_name="skills")
    op.drop_index("skills_sparse_embedding_gin_idx", table_name="skills")
    pass
