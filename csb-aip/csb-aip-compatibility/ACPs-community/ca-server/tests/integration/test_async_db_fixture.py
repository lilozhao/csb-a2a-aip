"""异步数据库 fixture 集成测试。"""

from uuid import uuid4

from app.acme.schema import AccountCreate
from app.acme.service import AccountService, NonceService


async def test_async_db_session_supports_acme_services(async_db_session) -> None:
    """验证 async_db_session 可以直接驱动异步 ACME service。"""
    unique = uuid4().hex[:12].upper()
    nonce_service = NonceService(async_db_session)

    nonce = await nonce_service.generate_nonce()
    await async_db_session.commit()

    assert await nonce_service.validate_and_consume_nonce(nonce) is True

    account = await AccountService(async_db_session).create_account(
        AccountCreate(
            key_id=f"key-{unique}",
            public_key="{}",
            aic=f"AIC-{unique}",
        )
    )

    assert account.id is not None
