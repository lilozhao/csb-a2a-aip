"""add_verification_tables

Revision ID: e24d8c3b7f11
Revises: 9e1b6b59f6df
Create Date: 2026-04-11 17:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
import sqlmodel
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e24d8c3b7f11"
down_revision: str | None = "9e1b6b59f6df"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACCOUNT_USER_FK = "account_user.id"


def upgrade() -> None:
    """Upgrade schema."""
    verification_method = postgresql.ENUM(
        "AUTO",
        "MANUAL",
        name="verificationmethod",
        create_type=False,
    )
    verification_status = postgresql.ENUM(
        "PENDING",
        "APPROVED",
        "REJECTED",
        name="verificationstatus",
        create_type=False,
    )
    identity_document_type = postgresql.ENUM(
        "CN_ID_CARD",
        "PASSPORT",
        "OTHER",
        name="identitydocumenttype",
        create_type=False,
    )
    verification_method.create(op.get_bind(), checkfirst=True)
    verification_status.create(op.get_bind(), checkfirst=True)
    identity_document_type.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "identity_verification",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("id_type", identity_document_type, nullable=False),
        sa.Column("id_number_hash", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column(
            "real_name_encrypted",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
        ),
        sa.Column("method", verification_method, nullable=False),
        sa.Column("provider", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=True),
        sa.Column(
            "provider_request_id",
            sqlmodel.sql.sqltypes.AutoString(length=255),
            nullable=True,
        ),
        sa.Column("reviewer_id", sa.Uuid(), nullable=True),
        sa.Column("status", verification_status, nullable=False),
        sa.Column("decided_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("attachment_urls", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["reviewer_id"], [ACCOUNT_USER_FK]),
        sa.ForeignKeyConstraint(["user_id"], [ACCOUNT_USER_FK]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_identity_verification_id"),
        "identity_verification",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_identity_verification_user_id"),
        "identity_verification",
        ["user_id"],
        unique=False,
    )

    op.create_table(
        "org_verification",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("org_name", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column("usci", sqlmodel.sql.sqltypes.AutoString(length=18), nullable=True),
        sa.Column(
            "org_registration_number",
            sqlmodel.sql.sqltypes.AutoString(length=255),
            nullable=True,
        ),
        sa.Column(
            "legal_rep_name_encrypted",
            sqlmodel.sql.sqltypes.AutoString(length=2048),
            nullable=True,
        ),
        sa.Column(
            "legal_rep_id_hash",
            sqlmodel.sql.sqltypes.AutoString(length=2048),
            nullable=True,
        ),
        sa.Column("method", verification_method, nullable=False),
        sa.Column("provider", sqlmodel.sql.sqltypes.AutoString(length=255), nullable=True),
        sa.Column(
            "provider_request_id",
            sqlmodel.sql.sqltypes.AutoString(length=255),
            nullable=True,
        ),
        sa.Column("reviewer_id", sa.Uuid(), nullable=True),
        sa.Column("status", verification_status, nullable=False),
        sa.Column("decided_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("attachment_urls", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["reviewer_id"], [ACCOUNT_USER_FK]),
        sa.ForeignKeyConstraint(["user_id"], [ACCOUNT_USER_FK]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_org_verification_id"), "org_verification", ["id"], unique=False)
    op.create_index(
        op.f("ix_org_verification_user_id"),
        "org_verification",
        ["user_id"],
        unique=False,
    )

    op.add_column("account_user", sa.Column("identity_verified", sa.Boolean(), nullable=True))
    op.execute("UPDATE account_user SET identity_verified = false WHERE identity_verified IS NULL")
    op.alter_column("account_user", "identity_verified", nullable=False)
    op.add_column(
        "account_user",
        sa.Column("identity_verified_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column("account_user", sa.Column("current_identity_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_account_user_current_identity_id"),
        "account_user",
        ["current_identity_id"],
        unique=False,
    )

    op.add_column("account_user", sa.Column("org_verified", sa.Boolean(), nullable=True))
    op.execute("UPDATE account_user SET org_verified = false WHERE org_verified IS NULL")
    op.alter_column("account_user", "org_verified", nullable=False)
    op.add_column(
        "account_user",
        sa.Column("org_verified_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.add_column("account_user", sa.Column("current_org_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_account_user_current_org_id"),
        "account_user",
        ["current_org_id"],
        unique=False,
    )

    op.create_foreign_key(
        "fk_account_user_current_identity_id",
        "account_user",
        "identity_verification",
        ["current_identity_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_account_user_current_org_id",
        "account_user",
        "org_verification",
        ["current_org_id"],
        ["id"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("fk_account_user_current_org_id", "account_user", type_="foreignkey")
    op.drop_constraint("fk_account_user_current_identity_id", "account_user", type_="foreignkey")
    op.drop_index(op.f("ix_account_user_current_org_id"), table_name="account_user")
    op.drop_column("account_user", "current_org_id")
    op.drop_column("account_user", "org_verified_at")
    op.drop_column("account_user", "org_verified")
    op.drop_index(op.f("ix_account_user_current_identity_id"), table_name="account_user")
    op.drop_column("account_user", "current_identity_id")
    op.drop_column("account_user", "identity_verified_at")
    op.drop_column("account_user", "identity_verified")

    op.drop_index(op.f("ix_org_verification_user_id"), table_name="org_verification")
    op.drop_index(op.f("ix_org_verification_id"), table_name="org_verification")
    op.drop_table("org_verification")
    op.drop_index(op.f("ix_identity_verification_user_id"), table_name="identity_verification")
    op.drop_index(op.f("ix_identity_verification_id"), table_name="identity_verification")
    op.drop_table("identity_verification")

    sa.Enum(name="identitydocumenttype").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="verificationstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="verificationmethod").drop(op.get_bind(), checkfirst=True)
