"""
Mock集成功能测试

验证RegistryClient和MockDataGenerator的Mock模式是否正常工作
"""

from unittest.mock import patch

import pytest

from app.acme.mock_data import MockDataGenerator
from app.acme.registry_client import RegistryClient


class TestMockIntegration:
    """Mock集成功能测试类"""

    @pytest.fixture(autouse=True)
    def setup_mock_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """为每个测试方法设置Mock模式"""
        monkeypatch.setenv("REGISTRY_SERVER_MOCK", "true")

    async def test_registry_server_mock_mode(self) -> None:
        """测试RegistryClient的Mock功能"""
        with patch("app.acme.registry_client.get_settings") as mock_settings:
            # Mock配置
            mock_settings.return_value.registry_server_url = "http://test-registry"
            mock_settings.return_value.registry_server_timeout = 10
            mock_settings.return_value.registry_server_internal_api_token = "test-token"
            mock_settings.return_value.external_service_max_retries = 3
            mock_settings.return_value.external_service_retry_delays_list = [1, 2, 4]
            mock_settings.return_value.registry_server_mock = True

            client = RegistryClient()

            # 验证Mock模式已启用
            assert client.is_mock_enabled is True

            test_aic = "test-agent-123"

            # 测试AIC验证和信息获取
            agent_info = await client.validate_aic_and_get_info(test_aic)
            assert agent_info is not None
            assert agent_info.aic == test_aic
            assert isinstance(agent_info.organization, str)
            assert len(agent_info.organization) > 0
            assert agent_info.country_code in MockDataGenerator.COUNTRIES
            assert agent_info.active in [True, False]

            # 测试证书请求注册
            reg_result = await client.register_certificate_request(test_aic, "order-123")
            assert isinstance(reg_result, bool)

            # 测试证书签发通知
            notify_result = await client.notify_certificate_issued(test_aic, "order-123", "cert-456")
            assert isinstance(notify_result, bool)

            # 测试所有权验证
            account_info = {"key_id": "test-key", "contact": "test@example.com"}
            ownership_result = await client.verify_agent_ownership(test_aic, account_info)
            assert isinstance(ownership_result, bool)

    async def test_mock_randomness(self) -> None:
        """测试Mock数据的随机性"""
        with patch("app.acme.registry_client.get_settings") as mock_settings:
            # Mock配置
            mock_settings.return_value.registry_server_url = "http://test-registry"
            mock_settings.return_value.registry_server_timeout = 10
            mock_settings.return_value.registry_server_internal_api_token = "test-token"
            mock_settings.return_value.external_service_max_retries = 3
            mock_settings.return_value.external_service_retry_delays_list = [1, 2, 4]
            mock_settings.return_value.registry_server_mock = True

            client = RegistryClient()

            # 进行多次相同的请求，验证随机性
            organizations = []
            countries = []
            statuses = []

            for i in range(10):
                agent_info = await client.validate_aic_and_get_info(f"random-agent-{i}")
                if agent_info:
                    organizations.append(agent_info.organization)
                    countries.append(agent_info.country_code)
                    statuses.append("active" if agent_info.active else "inactive")

            # 验证有足够的随机性（不是所有值都相同）
            assert len(set(organizations)) > 1, "组织名称应该有随机性"
            # 由于国家和状态的选项有限，可能会有重复，但组织名称应该有较好的随机性

    def test_mock_data_generator_agent_info(self) -> None:
        """测试MockDataGenerator生成Agent信息的功能"""
        generator = MockDataGenerator()

        # 测试生成指定AIC的Agent信息
        test_aic = "TESTAGENT123GENERATOR4567890ABCDE"
        agent_data = generator.generate_agent_info(test_aic)

        # 验证 ACS 格式的数据结构
        assert agent_data["aic"] == test_aic
        assert "active" in agent_data
        assert isinstance(agent_data["active"], bool)
        assert "name" in agent_data
        assert "version" in agent_data
        assert "provider" in agent_data
        assert "securitySchemes" in agent_data
        assert "endPoints" in agent_data
        assert "capabilities" in agent_data
        assert "skills" in agent_data

        # 验证 provider 信息结构
        provider = agent_data["provider"]
        required_provider_fields = [
            "organization",
            "department",
            "countryCode",
        ]
        for field in required_provider_fields:
            assert field in provider
            assert isinstance(provider[field], str)
            assert len(provider[field]) > 0

        # 验证 securitySchemes 结构
        security_schemes = agent_data["securitySchemes"]
        assert "mtls" in security_schemes
        mtls_config = security_schemes["mtls"]
        assert mtls_config["type"] == "mutualTLS"
        assert isinstance(mtls_config["description"], str)
        assert len(mtls_config["description"]) > 0

        # 验证 endPoints 结构
        assert len(agent_data["endPoints"]) > 0
        endpoint = agent_data["endPoints"][0]
        assert "url" in endpoint
        assert "security" in endpoint
        assert "transport" in endpoint

    def test_mock_data_generator_randomness(self) -> None:
        """测试MockDataGenerator的随机性"""
        generator = MockDataGenerator()

        # 生成多个Agent信息
        agent_data_list = []
        for i in range(10):
            agent_data = generator.generate_agent_info(f"TESTAIC{i:030d}")
            agent_data_list.append(agent_data)

        # 提取组织名称（从 provider.organization）
        organizations = [data["provider"]["organization"] for data in agent_data_list]

        # 验证随机性
        unique_organizations = set(organizations)
        assert len(unique_organizations) > 1, f"应该生成不同的组织名称，实际: {organizations}"

    def test_mock_consistent_results(self) -> None:
        """测试Mock功能始终返回成功结果"""
        generator = MockDataGenerator()

        # 测试端点验证始终成功
        endpoint_results = [generator.generate_endpoint_validation_result() for _ in range(100)]
        assert all(endpoint_results), "端点验证Mock应该始终返回成功"

        # 测试注册结果始终成功
        registration_results = [generator.generate_registration_result() for _ in range(100)]
        assert all(registration_results), "注册Mock应该始终返回成功"

        # 测试通知结果始终成功
        notification_results = [generator.generate_notification_result() for _ in range(100)]
        assert all(notification_results), "通知Mock应该始终返回成功"

        # 测试所有权验证始终成功
        ownership_results = [generator.generate_ownership_verification_result() for _ in range(100)]
        assert all(ownership_results), "所有权验证Mock应该始终返回成功"
