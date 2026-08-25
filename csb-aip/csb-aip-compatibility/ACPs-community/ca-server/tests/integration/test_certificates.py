"""
证书管理API单元测试

使用pytest框架测试证书管理相关的API接口
"""

import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.common import beijing_now
from app.main import app


class TestCertificatesAPI:
    """证书管理API测试类"""

    @pytest.fixture
    def client(self):
        """创建测试客户端"""
        with TestClient(app, headers={"Authorization": f"Bearer {os.environ['CA_SERVER_ADMIN_API_TOKEN']}"}) as client:
            yield client

    @pytest.fixture
    def root_cert_data(self):
        """根证书测试数据"""
        return {
            "subject_name": "CN=Test Root CA,O=Test Organization,C=CN",
            "validity_days": 3650,
        }

    def test_health_check(self, client) -> None:
        """测试健康检查接口"""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["service"] == "Agent CA API"

    @pytest.fixture
    def created_root_cert(self, client, root_cert_data):
        """创建根证书并返回"""
        response = client.post("/admin/certificates/root", json=root_cert_data)
        assert response.status_code == 200
        return response.json()

    def test_create_root_certificate(self, client, root_cert_data) -> None:
        """测试创建根证书"""
        response = client.post("/admin/certificates/root", json=root_cert_data)
        assert response.status_code == 200

        cert = response.json()
        assert cert["certificate_type"] == "root"
        assert cert["subject"] == root_cert_data["subject_name"]
        assert cert["issuer"] == root_cert_data["subject_name"]  # 自签名
        assert cert["status"] == "valid"
        assert "certificate_pem" in cert
        assert "public_key" in cert
        assert cert["parent_certificate_id"] is None

    def test_get_root_certificates(self, client) -> None:
        """测试获取根证书列表"""
        response = client.get("/admin/certificates/root")
        assert response.status_code == 200

        certificates = response.json()
        assert isinstance(certificates, list)
        # 确保所有返回的证书都是根证书
        for cert in certificates:
            assert cert["certificate_type"] == "root"

    def test_create_intermediate_certificate(self, client, created_root_cert) -> None:
        """测试创建中间证书"""
        root_cert = created_root_cert

        # 创建中间证书
        intermediate_data = {
            "subject_name": "CN=Test Intermediate CA,O=Test Organization,C=CN",
            "parent_certificate_id": root_cert["id"],
            "validity_days": 1825,
        }

        response = client.post("/admin/certificates/intermediate", json=intermediate_data)
        assert response.status_code == 200

        cert = response.json()
        assert cert["certificate_type"] == "intermediate"
        assert cert["subject"] == intermediate_data["subject_name"]
        assert cert["issuer"] == root_cert["subject"]
        assert cert["status"] == "valid"
        assert cert["parent_certificate_id"] == root_cert["id"]

    def test_get_certificate_by_id(self, client, created_root_cert) -> None:
        """测试根据ID获取证书详情"""
        created_cert = created_root_cert

        # 获取证书详情
        response = client.get(f"/admin/certificates/{created_cert['id']}")
        assert response.status_code == 200

        cert = response.json()
        assert cert["id"] == created_cert["id"]
        assert cert["subject"] == created_cert["subject"]

    def test_get_certificate_chain(self, client, created_root_cert) -> None:
        """测试获取证书链"""
        root_cert = created_root_cert

        # 创建中间证书
        intermediate_data = {
            "subject_name": "CN=Test Intermediate CA,O=Test Organization,C=CN",
            "parent_certificate_id": root_cert["id"],
            "validity_days": 1825,
        }

        response = client.post("/admin/certificates/intermediate", json=intermediate_data)
        assert response.status_code == 200
        intermediate_cert = response.json()

        # 获取中间证书的证书链
        response = client.get(f"/admin/certificates/{intermediate_cert['id']}/chain")
        assert response.status_code == 200

        chain = response.json()
        assert isinstance(chain, list)
        assert len(chain) == 2  # 中间证书 + 根证书

        # 验证证书链顺序：用户证书 -> 根证书
        assert chain[0]["id"] == intermediate_cert["id"]
        assert chain[1]["id"] == root_cert["id"]
        assert chain[0]["certificate_type"] == "intermediate"
        assert chain[1]["certificate_type"] == "root"

    def test_list_certificates_with_pagination(self, client) -> None:
        """测试分页查询证书列表"""
        response = client.get("/admin/certificates?page=1&page_size=5")
        assert response.status_code == 200

        data = response.json()
        assert "items" in data
        assert "total" in data
        assert "page" in data
        assert "page_size" in data
        assert "total_pages" in data

        assert data["page"] == 1
        assert data["page_size"] == 5
        assert len(data["items"]) <= 5

    def test_list_certificates_with_filter(self, client) -> None:
        """测试过滤查询证书列表"""
        # 按类型过滤
        response = client.get("/admin/certificates?certificate_type=root")
        assert response.status_code == 200

        data = response.json()
        for item in data["items"]:
            assert item["certificate_type"] == "root"

    def test_download_certificate(self, client, created_root_cert) -> None:
        """测试下载证书"""
        created_cert = created_root_cert

        # 下载证书
        response = client.get(f"/admin/certificates/{created_cert['id']}/download")
        assert response.status_code == 200
        assert "BEGIN CERTIFICATE" in response.text
        assert "END CERTIFICATE" in response.text

    def test_revoke_certificate(self, client, created_root_cert) -> None:
        """测试吊销证书"""
        created_cert = created_root_cert

        # 吊销证书
        response = client.post(
            f"/admin/certificates/{created_cert['id']}/revoke",
            params={"reason": "keyCompromise"},
        )
        assert response.status_code == 200

        revoked_cert = response.json()
        assert revoked_cert["status"] == "revoked"
        assert revoked_cert["revocation_reason"] == "keyCompromise"
        assert revoked_cert["revoked_at"] is not None

    def test_certificate_not_found(self, client) -> None:
        """测试获取不存在的证书"""
        fake_id = "01234567-89ab-cdef-0123-456789abcdef"
        response = client.get(f"/admin/certificates/{fake_id}")
        assert response.status_code == 404

    def test_create_intermediate_with_invalid_parent(self, client) -> None:
        """测试使用无效父证书创建中间证书"""
        fake_parent_id = "01234567-89ab-cdef-0123-456789abcdef"
        intermediate_data = {
            "subject_name": "CN=Test Intermediate CA,O=Test Organization,C=CN",
            "parent_certificate_id": fake_parent_id,
            "validity_days": 1825,
        }

        response = client.post("/admin/certificates/intermediate", json=intermediate_data)
        assert response.status_code == 400
        assert "Parent certificate is missing or invalid." in response.json()["detail"]

    def test_invalid_pagination_parameters(self, client) -> None:
        """测试无效的分页参数"""
        # 负数页码
        response = client.get("/admin/certificates?page=0")
        assert response.status_code == 422

        # 超大页面大小
        response = client.get("/admin/certificates?page_size=1000")
        assert response.status_code == 422


class TestCertificateService:
    """证书服务层测试"""

    def test_certificate_expiry_calculation(self, client) -> None:
        """测试证书过期时间计算"""
        cert_data = {"subject_name": "CN=Test CA,O=Test Org,C=CN", "validity_days": 30}
        beijing_tz = ZoneInfo("Asia/Shanghai")

        before_creation = beijing_now()
        response = client.post("/admin/certificates/root", json=cert_data)
        after_creation = beijing_now()

        assert response.status_code == 200
        cert = response.json()

        # 解析过期时间
        expires_at = datetime.fromisoformat(cert["expires_at"]).astimezone(beijing_tz)
        expected_min = before_creation + timedelta(days=30)
        expected_max = after_creation + timedelta(days=30)

        # 验证过期时间在合理范围内
        assert expected_min <= expires_at <= expected_max

    def test_certificate_serial_number_uniqueness(self, client) -> None:
        """测试证书序列号唯一性"""
        cert_data = {"subject_name": "CN=Test CA,O=Test Org,C=CN", "validity_days": 365}

        # 创建两个证书
        response1 = client.post("/admin/certificates/root", json=cert_data)
        response2 = client.post("/admin/certificates/root", json=cert_data)

        assert response1.status_code == 200
        assert response2.status_code == 200

        cert1 = response1.json()
        cert2 = response2.json()

        # 验证序列号不同
        assert cert1["serial_number"] != cert2["serial_number"]
        assert cert1["id"] != cert2["id"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
