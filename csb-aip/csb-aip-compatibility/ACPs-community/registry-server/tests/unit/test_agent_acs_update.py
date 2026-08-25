from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from app.agent.model import Agent
from app.agent.service import update_agent_acs_data

pytestmark = pytest.mark.unit


class TestUpdateAgentAcsData:
    def test_update_agent_acs_data_updates_aic_and_reassigns_acs(self) -> None:
        """
        验证 update_agent_acs_data 会更新 ACS 中的 AIC，
        并重新赋值 ACS 字典给 agent 对象，以确保 SQLAlchemy 能检测到变更。
        """
        # 准备测试数据
        initial_acs = {"name": "Test Agent", "version": "1.0.0", "active": True}

        # 构造 mock Agent
        agent = MagicMock(spec=Agent)
        agent.acs = initial_acs
        agent.aic = "test-aic-123"
        agent.is_active = True

        # mock 数据库会话
        db = MagicMock()

        # mock get_beijing_time，返回固定时间
        fixed_time = datetime(2023, 1, 1, 12, 0, 0, tzinfo=UTC)

        with (
            patch("app.agent.service.get_beijing_time", return_value=fixed_time),
            patch("app.sync.service.update_agent_with_changelog") as mock_sync,
        ):
            # 执行被测逻辑
            update_agent_acs_data(agent, db)

            # 校验结果
            # 1. 确认 ACS 中新增了 AIC
            assert agent.acs["aic"] == "test-aic-123"

            # 2. 确认新增了 lastModifiedTime
            assert agent.acs["lastModifiedTime"] == fixed_time.isoformat()

            # 3. 关键：确认 agent.acs 与 initial_acs 不是同一个对象
            # 这说明函数内部创建了副本并重新赋值
            assert agent.acs is not initial_acs

            # 4. 确认同步函数被调用
            mock_sync.assert_called_once()

    def test_update_agent_acs_data_no_change(self) -> None:
        """
        验证当内容没有变化时，ACS 不会被修改，且不会触发同步。
        """
        # 准备测试数据
        fixed_time = datetime(2023, 1, 1, 12, 0, 0, tzinfo=UTC)
        initial_acs = {
            "name": "Test Agent",
            "version": "1.0.0",
            "active": True,
            "aic": "test-aic-123",
            "lastModifiedTime": fixed_time.isoformat(),
        }

        agent = MagicMock(spec=Agent)
        agent.acs = initial_acs
        agent.aic = "test-aic-123"
        agent.is_active = True

        db = MagicMock()

        with (
            patch("app.agent.service.get_beijing_time", return_value=fixed_time),
            patch("app.sync.service.update_agent_with_changelog") as mock_sync,
        ):
            # 执行被测逻辑
            update_agent_acs_data(agent, db)

            # 校验结果
            mock_sync.assert_not_called()

            # 无变更时，agent.acs 应保持原对象不变
            assert agent.acs is initial_acs

    def test_update_agent_acs_data_active_status_change(self) -> None:
        """
        验证 active 状态变化时，ACS 会同步更新。
        """
        # 准备测试数据
        initial_acs = {
            "name": "Test Agent",
            "version": "1.0.0",
            "active": True,
            "aic": "test-aic-123",
        }

        agent = MagicMock(spec=Agent)
        agent.acs = initial_acs
        agent.aic = "test-aic-123"
        agent.is_active = False  # 修改为 False

        db = MagicMock()

        with (
            patch("app.agent.service.get_beijing_time") as mock_time,
            patch("app.sync.service.update_agent_with_changelog") as mock_sync,
        ):
            mock_time.return_value = datetime.now(tz=UTC)
            # 执行被测逻辑
            update_agent_acs_data(agent, db)

            # 校验结果
            assert agent.acs["active"] is False
            assert agent.acs is not initial_acs
            mock_sync.assert_called_once()

    def test_update_agent_acs_data_replaces_amqp_aic_placeholder(self) -> None:
        """
        验证审批通过后，AMQP 端点 URL 中的 {AIC} 占位符会被替换。
        """
        initial_acs = {
            "name": "Test Agent",
            "version": "1.0.0",
            "active": True,
            "endPoints": [
                {
                    "url": "https://agent.example.com/rpc",
                    "transport": "JSONRPC",
                },
                {
                    "url": "amqps://mq.example.com:5671/acps?inbox=inbox_{AIC}",
                    "transport": "AMQP",
                },
            ],
        }

        agent = MagicMock(spec=Agent)
        agent.acs = initial_acs
        agent.aic = "test-aic-123"
        agent.is_active = True

        db = MagicMock()
        fixed_time = datetime(2023, 1, 1, 12, 0, 0, tzinfo=UTC)

        with (
            patch("app.agent.service.get_beijing_time", return_value=fixed_time),
            patch("app.sync.service.update_agent_with_changelog") as mock_sync,
        ):
            update_agent_acs_data(agent, db)

            assert agent.acs["endPoints"][1]["url"] == "amqps://mq.example.com:5671/acps?inbox=inbox_test-aic-123"
            assert agent.acs["lastModifiedTime"] == fixed_time.isoformat()
            assert agent.acs is not initial_acs
            mock_sync.assert_called_once()
