"""add certificate version

Revision ID: 9b3d2b7c1a6f
Revises: 612b6c93f9a9
Create Date: 2026-01-10

"""

import sqlalchemy as sa

from alembic import context, op

# revision identifiers, used by Alembic.
revision = "9b3d2b7c1a6f"
down_revision = "612b6c93f9a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """增加 certificates.version，并按时间顺序为历史数据回填版本号。

    规则：
    - 按 AIC 分组（仅对非空 AIC 生效）
    - 按 created_at、id 升序排序
    - version 从 1 开始递增（row_number）
    - AIC 为空/NULL 的记录统一设置为 1

    说明：upgrade 内做了列存在性检查，以便在“库已被手工改过，但 alembic 版本未对齐”的场景下也能安全运行。
    """

    # 离线模式（`alembic upgrade --sql`）下，bind 是 MockConnection，无法进行 schema inspection。
    # 此时直接生成 DDL；在线模式才做列存在性检查。
    if context.is_offline_mode():
        op.add_column(
            "certificates",
            sa.Column(
                "version",
                sa.Integer(),
                nullable=True,
                server_default=sa.text("1"),
            ),
        )
    else:
        bind = op.get_bind()
        inspector = sa.inspect(bind)
        columns = {c["name"] for c in inspector.get_columns("certificates")}
        if "version" not in columns:
            op.add_column(
                "certificates",
                sa.Column(
                    "version",
                    sa.Integer(),
                    nullable=True,
                    server_default=sa.text("1"),
                ),
            )

    # 先为 AIC 为空/NULL 的证书设置 version=1
    op.execute(
        """
        UPDATE certificates
        SET version = 1
        WHERE (aic IS NULL OR btrim(aic) = '')
          AND (version IS NULL OR version < 1);
        """
    )

    # 对 AIC 非空的证书：按 created_at、id 升序，为每个 AIC 生成 1..N
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY aic
                    ORDER BY created_at ASC, id ASC
                ) AS rn
            FROM certificates
            WHERE aic IS NOT NULL AND btrim(aic) <> ''
        )
        UPDATE certificates c
        SET version = r.rn
        FROM ranked r
        WHERE c.id = r.id;
        """
    )

    # 兜底：保证没有 NULL
    op.execute("UPDATE certificates SET version = 1 WHERE version IS NULL;")

    # 最终约束：NOT NULL + 默认值
    op.alter_column(
        "certificates",
        "version",
        existing_type=sa.Integer(),
        nullable=False,
        server_default=sa.text("1"),
    )


def downgrade() -> None:
    if context.is_offline_mode():
        op.drop_column("certificates", "version")
    else:
        bind = op.get_bind()
        inspector = sa.inspect(bind)
        columns = {c["name"] for c in inspector.get_columns("certificates")}
        if "version" in columns:
            op.drop_column("certificates", "version")
