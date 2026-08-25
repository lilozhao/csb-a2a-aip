"""测试 app.common.certificate_version 的版本号生成逻辑。"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from app.common.certificate_version import get_next_certificate_version


def _make_session(scalar_result):
    """构建返回指定 scalar 值的 mock AsyncSession。"""
    mock_result = MagicMock()
    mock_result.scalar_one.return_value = scalar_result

    session = AsyncMock()
    session.execute = AsyncMock(return_value=mock_result)
    return session


class TestGetNextCertificateVersion:
    async def test_no_existing_certs_returns_1(self) -> None:
        """AIC 无任何证书记录时，版本号从 1 开始。"""
        session = _make_session(scalar_result=None)
        result = await get_next_certificate_version(session, "AIC-0000000000000000000000000001")
        assert result == 1

    async def test_existing_max_version_increments(self) -> None:
        """AIC 已有 max version=3 时，返回 4。"""
        session = _make_session(scalar_result=3)
        result = await get_next_certificate_version(session, "AIC-0000000000000000000000000001")
        assert result == 4

    async def test_max_version_zero_returns_1(self) -> None:
        """数据库返回 max=0（异常边界），仍返回 1。"""
        session = _make_session(scalar_result=0)
        result = await get_next_certificate_version(session, "AIC-0000000000000000000000000001")
        assert result == 1

    async def test_max_version_large_number(self) -> None:
        """验证大版本号的自增计算正确。"""
        session = _make_session(scalar_result=999)
        result = await get_next_certificate_version(session, "AIC-0000000000000000000000000001")
        assert result == 1000

    async def test_empty_aic_returns_1_without_db_query(self) -> None:
        """空 AIC 时跳过 DB 查询直接返回 1（短路逻辑）。"""
        session = AsyncMock()
        result = await get_next_certificate_version(session, "")
        assert result == 1
        session.execute.assert_not_called()

    async def test_session_execute_called_with_select(self) -> None:
        """非空 AIC 时，session.execute 必须被调用一次。"""
        session = _make_session(scalar_result=5)
        await get_next_certificate_version(session, "AIC-0000000000000000000000000001")
        session.execute.assert_called_once()

    async def test_different_aics_use_provided_aic(self) -> None:
        """不同 AIC 值不影响版本号计算逻辑（版本号由 DB 返回值决定）。"""
        session = _make_session(scalar_result=2)
        result1 = await get_next_certificate_version(session, "AIC-AAA")
        result2 = await get_next_certificate_version(session, "AIC-BBB")
        assert result1 == result2 == 3
