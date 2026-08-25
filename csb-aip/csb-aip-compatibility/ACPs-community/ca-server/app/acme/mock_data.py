"""
Mock数据和工具类

为开发和测试环境提供模拟的外部服务数据
"""

import os
import random
import secrets
import string
import time
from datetime import UTC, datetime
from typing import Any, ClassVar


class MockDataGenerator:
    """Mock数据生成器"""

    # 预定义的组织名称池
    ORGANIZATIONS: ClassVar[list[str]] = [
        "TechCorp Solutions",
        "DataFlow Systems",
        "CloudEdge Innovations",
        "NeuralNet Dynamics",
        "QuantumByte Technologies",
        "AI Fusion Labs",
        "CyberSecure Networks",
        "SmartGrid Analytics",
        "RoboTech Industries",
        "BlockChain Ventures",
        "IoT Connected Ltd",
        "EdgeCompute Corp",
    ]

    # 预定义的部门名称池
    DEPARTMENTS: ClassVar[list[str]] = [
        "Engineering",
        "Research & Development",
        "AI Operations",
        "Data Science",
        "Security Division",
        "Infrastructure",
        "Platform Services",
        "DevOps",
        "Machine Learning",
        "Analytics",
    ]

    # 预定义的国家代码池
    COUNTRIES: ClassVar[list[str]] = [
        "US",
        "CA",
        "GB",
        "DE",
        "FR",
        "JP",
        "AU",
        "SG",
        "NL",
        "SE",
    ]

    # 预定义的城市池
    CITIES: ClassVar[list[str]] = [
        "New York",
        "London",
        "Tokyo",
        "San Francisco",
        "Berlin",
        "Toronto",
        "Sydney",
        "Singapore",
        "Amsterdam",
        "Stockholm",
    ]

    # 预定义的域名后缀
    DOMAIN_SUFFIXES: ClassVar[list[str]] = [
        ".com",
        ".org",
        ".net",
        ".ai",
        ".tech",
        ".cloud",
    ]

    # 预定义的状态池
    AGENT_STATUSES: ClassVar[list[str]] = ["active", "pending", "maintenance"]

    @classmethod
    def random_string(cls, length: int, chars: str = string.ascii_lowercase) -> str:
        """生成随机字符串"""
        return "".join(random.choice(chars) for _ in range(length))

    @classmethod
    def random_number_string(cls, length: int) -> str:
        """生成随机数字字符串"""
        return "".join(random.choice(string.digits) for _ in range(length))

    @classmethod
    def generate_email(cls, company: str) -> str:
        """生成公司邮箱"""
        domain = company.lower().replace(" ", "").replace("&", "and")
        domain = "".join(c for c in domain if c.isalnum())
        username = cls.random_string(random.randint(5, 10))
        return f"{username}@{domain}.com"

    @classmethod
    def generate_domain(cls) -> str:
        """生成域名"""
        prefix = cls.random_string(random.randint(6, 12))
        suffix = random.choice(cls.DOMAIN_SUFFIXES)
        return f"{prefix}{suffix}"

    @classmethod
    def generate_aic(cls) -> str:
        """
        生成随机的 AIC (Agent Identity Code)

        与 registry-server/app/utils/aic.py 的实现保持一致：

        - AIC 为点分 10 段
        - 前缀为 1.2.156.3088
        - 第 10 段为 CRC-16/CCITT-FALSE 校验码的 Base36 编码（固定 4 位，大写，左侧 0 补齐）
        - CRC 计算输入为 1~9 段（含 '.'）的 ASCII 字节流，末尾追加盐 AIC_CRC_SALT（十六进制字符串，默认 0x0000ABCD）
        """
        base36 = string.digits + string.ascii_uppercase

        def _base36_encode_fixed(num: int, length: int = 4) -> str:
            if num < 0:
                num = 0
            if num == 0:
                return "0".rjust(length, "0")
            chars: list[str] = []
            while num > 0:
                num, rem = divmod(num, 36)
                chars.append(base36[rem])
            encoded = "".join(reversed(chars)).upper()
            return encoded.rjust(length, "0")[-length:]

        def _rand_seg(min_len: int, max_len: int) -> str:
            length = random.randint(min_len, max_len)
            return "".join(random.choice(base36) for _ in range(length))

        def _crc16_ccitt_false(data: bytes) -> int:
            crc = 0xFFFF
            for b in data:
                crc ^= (b << 8) & 0xFFFF
                for _ in range(8):
                    crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
            return crc & 0xFFFF

        def _salt_bytes() -> bytes:
            salt = os.getenv("AIC_CRC_SALT", "0x0000ABCD")
            try:
                salt_hex = salt[2:] if salt.lower().startswith("0x") else salt
                if len(salt_hex) % 2 != 0:
                    salt_hex = "0" + salt_hex
                return bytes.fromhex(salt_hex)
            except Exception:
                return b"\xff\xff"

        prefix = "1.2.156.3088"
        arsp = _rand_seg(1, 6)
        vendor = _rand_seg(1, 6)
        ontology_sn = _rand_seg(6, 6)
        instance_sn = _rand_seg(6, 6)
        # 避免全0实例
        while set(instance_sn) == {"0"}:
            instance_sn = _rand_seg(6, 6)
        ver = random.choice(base36)

        body_1_9 = f"{prefix}.{ver}.{arsp}.{vendor}.{ontology_sn}.{instance_sn}"
        crc = _crc16_ccitt_false(body_1_9.encode("ascii") + _salt_bytes())
        return f"{body_1_9}.{_base36_encode_fixed(crc, 4)}"

    @classmethod
    def generate_organization_info(cls) -> dict[str, str]:
        """生成组织信息"""
        org_name = random.choice(cls.ORGANIZATIONS)
        return {
            "organizationName": org_name,
            "organizationalUnit": random.choice(cls.DEPARTMENTS),
            "country": random.choice(cls.COUNTRIES),
            "state": cls.random_string(2, string.ascii_uppercase),
            "locality": random.choice(cls.CITIES),
            "contactEmail": cls.generate_email(org_name),
        }

    @classmethod
    def generate_agent_info(cls, aic: str | None = None) -> dict[str, Any]:
        """
        生成完整的 Agent 信息 - 符合 ACS 数据结构

        根据 ATR-DESIGN.md 2.3.1 章节的响应数据结构生成 mock 数据
        """
        if not aic:
            aic = cls.generate_aic()

        # Mock模式下始终返回激活状态，确保测试流程可预测
        is_active = True

        org_info = cls.generate_organization_info()

        # 生成 agent 名称和版本
        agent_name = f"{random.choice(['Agent', 'Node', 'Client', 'Service'])}-{aic[-8:]}"
        version = f"{random.randint(1, 3)}.{random.randint(0, 9)}.{random.randint(0, 9)}"

        domain = cls.generate_domain()

        # 生成能力和技能信息
        capabilities = {
            "communication": ["jsonrpc", "rest"],
            "security": ["mtls", "oauth2"],
            "protocols": ["acps-aip-v2"],
        }

        skills = [
            {"name": "data_processing", "version": "1.0"},
            {"name": "ml_inference", "version": "2.1"},
            {"name": "text_generation", "version": "1.5"},
        ]

        # 生成端点信息
        endpoints = [
            {
                "url": f"https://{domain}/acps-aip-v2/rpc",
                "security": [{"mtls": []}],
                "transport": "JSONRPC",
            }
        ]

        # 根据 ACS 格式构造完整的响应数据
        return {
            "aic": aic,
            "active": is_active,
            "name": agent_name,
            "version": version,
            "provider": {
                "organization": org_info["organizationName"],
                "department": org_info["organizationalUnit"],
                "countryCode": org_info["country"],
            },
            "securitySchemes": {
                "mtls": {
                    "description": "智能体间mTLS双向认证",
                    "type": "mutualTLS",
                }
            },
            "endPoints": endpoints,
            "capabilities": capabilities,
            "skills": skills,
            "certificate": {
                "altNames": {
                    "dns": [],
                    "ip": [],
                },
                "requestedValidity": None,
            },
        }

    # 以下方法供AgentRegistryClient调用

    def generate_endpoint_validation_result(self) -> bool:
        """生成端点验证结果，始终返回成功，确保流程可预测"""
        return True

    def generate_registration_result(self) -> bool:
        """生成证书请求注册结果，始终返回成功，确保流程可预测"""
        return True

    def generate_notification_result(self) -> bool:
        """生成证书签发通知结果，始终返回成功，确保流程可预测"""
        return True

    def generate_ownership_verification_result(self) -> bool:
        """生成所有权验证结果，始终返回成功，确保流程可预测"""
        return True

    def generate_pre_validation_result(self, aic: str) -> dict[str, Any]:
        """生成预验证结果"""
        # Mock模式下始终返回成功，确保测试流程可预测
        success = True

        if success:
            return {"success": True, "details": {"agent_id": aic, "status": "healthy"}}
        error_scenarios = [
            "Agent health check failed: HTTP 503",
            "Agent ID mismatch in health check",
            "Pre-validation failed: Connection timeout",
        ]
        return {"success": False, "error": random.choice(error_scenarios)}


class MockDelaySimulator:
    """网络延迟模拟器"""

    @staticmethod
    def simulate_network_delay() -> float:
        """模拟网络延迟"""
        # 模拟不同的网络条件
        delay_scenarios = [
            (0.1, 0.3, 0.7),  # 本地网络 (70%概率)
            (0.5, 1.5, 0.2),  # 一般网络 (20%概率)
            (2.0, 5.0, 0.08),  # 慢网络 (8%概率)
            (10.0, 30.0, 0.02),  # 超慢网络 (2%概率)
        ]

        for min_delay, max_delay, probability in delay_scenarios:
            if random.random() < probability:
                delay = random.uniform(min_delay, max_delay)
                time.sleep(delay)
                return delay

        # 默认延迟
        delay = random.uniform(0.1, 0.3)
        time.sleep(delay)
        return delay


class MockCacheSimulator:
    """缓存模拟器，模拟真实的缓存行为"""

    def __init__(self, ttl_seconds: int = 300):
        self.cache: dict[str, dict[str, Any]] = {}
        self.ttl = ttl_seconds

    def get(self, key: str) -> Any | None:
        """获取缓存值"""
        if key in self.cache:
            entry = self.cache[key]
            if time.time() - entry["timestamp"] < self.ttl:
                # 模拟缓存命中的快速响应
                time.sleep(random.uniform(0.001, 0.01))
                return entry["data"]
            # 缓存过期
            del self.cache[key]
        return None

    def set(self, key: str, value: Any) -> None:
        """设置缓存值"""
        self.cache[key] = {"data": value, "timestamp": time.time()}

    def invalidate(self, key: str) -> None:
        """使缓存失效"""
        if key in self.cache:
            del self.cache[key]


# 全局缓存实例
mock_cache = MockCacheSimulator()


def generate_realistic_error(service_name: str, operation: str) -> dict[str, Any]:
    """生成真实的错误场景"""
    error_scenarios: dict[str, list[dict[str, Any]]] = {
        "agent_registry": [
            {"code": "RATE_LIMITED", "message": "Too many requests", "retry_after": 60},
            {
                "code": "SERVICE_UNAVAILABLE",
                "message": "Registry service under maintenance",
            },
            {"code": "AUTHENTICATION_FAILED", "message": "Invalid service token"},
            {"code": "AGENT_NOT_FOUND", "message": "Agent not found in registry"},
            {
                "code": "DATABASE_ERROR",
                "message": "Registry database connection failed",
            },
        ],
    }

    scenarios = error_scenarios.get(service_name, [])
    if scenarios:
        error = random.choice(scenarios)
        error["service"] = service_name
        error["operation"] = operation
        error["timestamp"] = datetime.now(UTC).isoformat()
        error["correlation_id"] = secrets.token_hex(8)
        return error

    return {
        "code": "UNKNOWN_ERROR",
        "message": f"Unknown error in {service_name}",
        "service": service_name,
        "operation": operation,
    }
