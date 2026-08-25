"""
测试应用基础功能

测试应用的基本健康检查和根路径。
"""

from fastapi.testclient import TestClient


def test_health_check(client: TestClient):
    """测试健康检查端点"""
    response = client.get("/health")
    assert response.status_code == 200

    data = response.json()
    assert data["status"] == "healthy"
    assert "service" in data
    assert "version" in data
    assert "environment" in data


def test_root_endpoint(client: TestClient):
    """测试根路径端点"""
    response = client.get("/")
    assert response.status_code == 200

    data = response.json()
    assert "message" in data
    assert "docs" in data
    assert "health" in data


def test_docs_available(client: TestClient):
    """测试 API 文档可用性"""
    response = client.get("/docs")
    assert response.status_code == 200


def test_redoc_available(client: TestClient):
    """测试 ReDoc 文档可用性"""
    response = client.get("/redoc")
    assert response.status_code == 200
