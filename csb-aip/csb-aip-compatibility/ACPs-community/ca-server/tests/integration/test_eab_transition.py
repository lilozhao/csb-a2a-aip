"""EAB 主链路与 challenge 兼容层保留测试。"""

import asyncio
import base64
import hashlib
import hmac
import json
from unittest.mock import AsyncMock, Mock, patch

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.acme.eab_verifier import verify_eab_binding
from app.acme.jws_verifier import JWSVerifier
from app.acme.registry_client import RegistryClient
from app.main import app


class StubRegistryClient:
    def __init__(self, mac_key: str, aic: str) -> None:
        self.mac_key = mac_key
        self.aic = aic
        self.calls: list[str] = []

    async def consume_eab_credential(self, key_id: str):
        await asyncio.sleep(0)
        self.calls.append(key_id)
        return self.mac_key, self.aic


def _build_test_jwk() -> dict[str, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key().public_numbers()
    n = public_key.n.to_bytes((public_key.n.bit_length() + 7) // 8, "big")
    e = public_key.e.to_bytes((public_key.e.bit_length() + 7) // 8, "big")
    return {
        "kty": "RSA",
        "n": base64.urlsafe_b64encode(n).decode("ascii").rstrip("="),
        "e": base64.urlsafe_b64encode(e).decode("ascii").rstrip("="),
    }


def test_directory_requires_external_account_binding() -> None:
    with TestClient(app) as client:
        response = client.get("/acps-atr-v2/acme/directory")

    assert response.status_code == 200
    assert response.json()["meta"]["externalAccountRequired"] is True


@pytest.mark.asyncio
async def test_validate_aic_no_longer_requires_challenge_url() -> None:
    """主链路测试：Registry 响应在 EAB 主链路下不再要求 challenge URL。"""
    test_response_data = {
        "aic": "AGENTTEST123SUCCESS4567890ABCDEF12",
        "active": True,
        "name": "Test Agent Service",
        "version": "1.0.0",
        "provider": {
            "organization": "Test Corp",
            "department": "AI Services",
            "countryCode": "US",
        },
        "securitySchemes": {
            "mtls": {
                "description": "智能体间mTLS双向认证",
                "type": "mutualTLS",
            }
        },
        "endPoints": [
            {
                "url": "https://agent.example.com/acps-aip-v2/rpc",
                "security": [{"mtls": []}],
                "transport": "JSONRPC",
            }
        ],
        "capabilities": {"communication": ["jsonrpc"]},
        "skills": [],
    }

    with patch("app.acme.registry_client.get_settings") as mock_settings:
        mock_settings.return_value.registry_server_url = "http://test-registry"
        mock_settings.return_value.registry_server_internal_url = ""
        mock_settings.return_value.registry_server_timeout = 10
        mock_settings.return_value.registry_server_internal_api_token = "test-token"
        mock_settings.return_value.external_service_max_retries = 3
        mock_settings.return_value.external_service_retry_delays_list = [1, 2, 4]
        mock_settings.return_value.registry_server_mock = False
        client = RegistryClient()

    with patch("httpx.AsyncClient") as mock_client:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = test_response_data
        mock_client.return_value.__aenter__.return_value.request = AsyncMock(return_value=mock_response)

        result = await client.validate_aic_and_get_info("AGENTTEST123SUCCESS4567890ABCDEF12")

    assert result is not None
    assert result.aic == "AGENTTEST123SUCCESS4567890ABCDEF12"


@pytest.mark.asyncio
async def test_consume_eab_credential_calls_internal_endpoint() -> None:
    with patch("app.acme.registry_client.get_settings") as mock_settings:
        mock_settings.return_value.registry_server_url = "http://test-registry/acps-atr-v2"
        mock_settings.return_value.registry_server_internal_url = ""
        mock_settings.return_value.registry_server_timeout = 10
        mock_settings.return_value.registry_server_internal_api_token = "test-token"
        mock_settings.return_value.external_service_max_retries = 3
        mock_settings.return_value.external_service_retry_delays_list = [1, 2, 4]
        mock_settings.return_value.registry_server_mock = False
        client = RegistryClient()

    with patch("httpx.AsyncClient") as mock_client:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"macKey": "secret", "aic": "AIC-1"}
        mock_request = mock_client.return_value.__aenter__.return_value.request
        mock_request.return_value = mock_response

        result = await client.consume_eab_credential("kid-1")

    assert result == ("secret", "AIC-1")
    mock_request.assert_called_once()
    args, kwargs = mock_request.call_args
    assert args[0] == "POST"
    assert args[1] == "http://test-registry/internal/eab/consume"
    assert kwargs["json"] == {"keyId": "kid-1"}


@pytest.mark.asyncio
async def test_verify_eab_binding_accepts_valid_hs256_signature() -> None:
    jwk = _build_test_jwk()
    verifier = JWSVerifier()
    mac_key_bytes = b"0123456789abcdef0123456789abcdef"
    mac_key = verifier.base64url_encode(mac_key_bytes)
    protected = {
        "alg": "HS256",
        "kid": "kid-1",
        "url": "https://ca.example.com/acme/new-account",
    }
    protected_b64 = verifier.base64url_encode(json.dumps(protected, separators=(",", ":")).encode("utf-8"))
    payload_b64 = verifier.base64url_encode(json.dumps(jwk, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(
        mac_key_bytes,
        f"{protected_b64}.{payload_b64}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    eab_jws = {
        "protected": protected_b64,
        "payload": payload_b64,
        "signature": verifier.base64url_encode(signature),
    }
    registry_client = StubRegistryClient(mac_key=mac_key, aic="AIC-1")

    bound_aic = await verify_eab_binding(
        eab_jws,
        jwk,
        "https://ca.example.com/acme/new-account",
        registry_client,
    )

    assert bound_aic == "AIC-1"
    assert registry_client.calls == ["kid-1"]
