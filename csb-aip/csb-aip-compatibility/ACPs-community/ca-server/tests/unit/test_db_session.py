"""测试 app.core.db_session 的数据库会话管理工具函数。

注意：db_session.py 在模块导入时即建立引擎连接（模块级代码），
因此测试着重覆盖可在不依赖真实 DB 的情况下执行的工具函数。
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch


class TestGetSyncEngine:
    def test_returns_sync_engine(self) -> None:
        from app.core.db_session import get_sync_engine, sync_engine

        result = get_sync_engine()
        assert result is sync_engine


class TestCreateDbAndTables:
    def test_success_logs_info(self) -> None:
        """成功建表时记录 info 日志。"""
        with (
            patch("app.core.db_session.SQLModel") as mock_sqlmodel,
            patch("app.core.db_session.logger") as mock_logger,
        ):
            mock_sqlmodel.metadata.create_all.return_value = None
            from app.core.db_session import create_db_and_tables

            create_db_and_tables()
            mock_logger.info.assert_called_once()

    def test_exception_logs_error_and_reraises(self) -> None:
        """建表异常时记录 error 日志并重新抛出。"""
        import pytest

        with (
            patch("app.core.db_session.SQLModel") as mock_sqlmodel,
            patch("app.core.db_session.logger") as mock_logger,
        ):
            mock_sqlmodel.metadata.create_all.side_effect = RuntimeError("connection refused")
            from app.core.db_session import create_db_and_tables

            with pytest.raises(RuntimeError, match="connection refused"):
                create_db_and_tables()
            mock_logger.error.assert_called_once()


class TestGetSyncSession:
    def test_yields_session_and_commits(self) -> None:
        """正常情况下 yield session 并 commit。"""
        mock_session = MagicMock()
        mock_context = MagicMock()
        mock_context.__enter__ = MagicMock(return_value=mock_session)
        mock_context.__exit__ = MagicMock(return_value=False)

        with patch("app.core.db_session.Session", return_value=mock_context):
            from app.core.db_session import get_sync_session

            gen = get_sync_session()
            session = next(gen)
            assert session is mock_session
            mock_session.commit.assert_not_called()
            # 消费完 generator（触发 finally/commit）
            import contextlib

            with contextlib.suppress(StopIteration):
                next(gen)
            mock_session.commit.assert_called_once()

    def test_yields_session_on_exception_rollback(self) -> None:
        """异常时执行 rollback 并重新抛出。"""
        import pytest

        mock_session = MagicMock()
        mock_context = MagicMock()
        mock_context.__enter__ = MagicMock(return_value=mock_session)
        mock_context.__exit__ = MagicMock(return_value=False)

        with patch("app.core.db_session.Session", return_value=mock_context):
            from app.core.db_session import get_sync_session

            gen = get_sync_session()
            next(gen)
            with pytest.raises(ValueError):
                gen.throw(ValueError("db error"))
            mock_session.rollback.assert_called_once()


class TestGetSession:
    def test_delegates_to_get_sync_session(self) -> None:
        """get_session 是 get_sync_session 的别名。"""
        mock_session = MagicMock()
        mock_context = MagicMock()
        mock_context.__enter__ = MagicMock(return_value=mock_session)
        mock_context.__exit__ = MagicMock(return_value=False)

        with patch("app.core.db_session.Session", return_value=mock_context):
            from app.core.db_session import get_session

            gen = get_session()
            session = next(gen)
            assert session is mock_session


class TestCloseSyncEngine:
    def test_calls_dispose(self) -> None:
        from app.core.db_session import close_sync_engine, sync_engine

        with patch.object(sync_engine, "dispose") as mock_dispose:
            close_sync_engine()
            mock_dispose.assert_called_once()


class TestCloseAsyncEngine:
    async def test_calls_dispose(self) -> None:
        mock_engine = AsyncMock()
        mock_engine.dispose = AsyncMock()

        with patch("app.core.db_session.async_engine", mock_engine):
            from app.core.db_session import close_async_engine

            await close_async_engine()
            mock_engine.dispose.assert_called_once()


class TestGetDb:
    def test_yields_session(self) -> None:
        """get_db 别名正常 yield session。"""
        mock_session = MagicMock()
        mock_context = MagicMock()
        mock_context.__enter__ = MagicMock(return_value=mock_session)
        mock_context.__exit__ = MagicMock(return_value=False)

        with patch("app.core.db_session.Session", return_value=mock_context):
            from app.core.db_session import get_db

            gen = get_db()
            session = next(gen)
            assert session is mock_session
