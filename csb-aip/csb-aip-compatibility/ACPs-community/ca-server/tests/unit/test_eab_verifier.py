"""acme/eab_verifier.py 单元测试 - mock registry_client 和 jws_verifier。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.acme.eab_verifier import _compose_jws_string, verify_eab_binding
from app.acme.exception import AcmeException


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _make_account_jwk() -> dict[str, Any]:
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": _b64url(b"\x01" * 32),
        "y": _b64url(b"\x02" * 32),
    }


def _make_eab_jws(
    mac_key_bytes: bytes,
    account_jwk: dict[str, Any],
    kid: str = "eab-key-id-001",
    url: str = "https://example.com/acme/new-account",
    alg: str = "HS256",
    corrupt_sig: bool = False,
) -> dict[str, Any]:
    """构造合法的 EAB JWS。"""
    protected_obj = {"alg": alg, "kid": kid, "url": url}
    protected_b64 = _b64url(json.dumps(protected_obj).encode())
    payload_b64 = _b64url(json.dumps(account_jwk).encode())
    signing_input = f"{protected_b64}.{payload_b64}".encode("ascii")
    sig_bytes = hmac.new(mac_key_bytes, signing_input, hashlib.sha256).digest()
    if corrupt_sig:
        sig_bytes = b"\x00" * len(sig_bytes)
    sig_b64 = _b64url(sig_bytes)
    return {"protected": protected_b64, "payload": payload_b64, "signature": sig_b64}


@pytest.fixture()
def mock_registry_client() -> MagicMock:
    client = MagicMock()
    client.consume_eab_credential = AsyncMock()
    return client


class TestComposeJwsString:
    def test_basic(self) -> None:
        eab_jws = {"protected": "prot", "payload": "pay", "signature": "sig"}
        result = _compose_jws_string(eab_jws)
        assert result == "prot.pay.sig"

    def test_missing_field_raises_acme_exception(self) -> None:
        with pytest.raises(AcmeException) as exc_info:
            _compose_jws_string({"protected": "p", "payload": "q"})
        assert exc_info.value.status_code == 400


class TestVerifyEabBinding:
    _URL = "https://example.com/acme/new-account"
    _MAC_KEY = b"\xde\xad\xbe\xef" * 8

    def _make_eab(self, **kwargs: Any) -> dict[str, Any]:
        account_jwk = kwargs.pop("account_jwk", _make_account_jwk())
        return _make_eab_jws(self._MAC_KEY, account_jwk, url=self._URL, **kwargs)

    @pytest.mark.asyncio
    async def test_success(self, mock_registry_client: MagicMock) -> None:
        account_jwk = _make_account_jwk()
        eab_jws = self._make_eab(account_jwk=account_jwk)
        mock_registry_client.consume_eab_credential.return_value = (_b64url(self._MAC_KEY), "AIC-001")

        with patch("app.acme.eab_verifier.get_jws_verifier") as mock_get:
            from app.acme.jws_verifier import JWSVerifier

            real_verifier = JWSVerifier()
            mock_get.return_value = real_verifier
            result = await verify_eab_binding(eab_jws, account_jwk, self._URL, mock_registry_client)
        assert result == "AIC-001"

    @pytest.mark.asyncio
    async def test_wrong_alg_raises(self, mock_registry_client: MagicMock) -> None:
        account_jwk = _make_account_jwk()
        eab_jws = self._make_eab(alg="RS256", account_jwk=account_jwk)
        with patch("app.acme.eab_verifier.get_jws_verifier") as mock_get:
            from app.acme.jws_verifier import JWSVerifier

            mock_get.return_value = JWSVerifier()
            with pytest.raises(AcmeException) as exc_info:
                await verify_eab_binding(eab_jws, account_jwk, self._URL, mock_registry_client)
        assert exc_info.value.status_code == 400
        assert "HS256" in exc_info.value.error_msg

    @pytest.mark.asyncio
    async def test_url_mismatch_raises(self, mock_registry_client: MagicMock) -> None:
        account_jwk = _make_account_jwk()
        eab_jws = _make_eab_jws(self._MAC_KEY, account_jwk, url="https://wrong.example.com/acme/new-account")
        with patch("app.acme.eab_verifier.get_jws_verifier") as mock_get:
            from app.acme.jws_verifier import JWSVerifier

            mock_get.return_value = JWSVerifier()
            with pytest.raises(AcmeException) as exc_info:
                await verify_eab_binding(eab_jws, account_jwk, self._URL, mock_registry_client)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_consume_eab_failed_raises(self, mock_registry_client: MagicMock) -> None:
        account_jwk = _make_account_jwk()
        eab_jws = self._make_eab(account_jwk=account_jwk)
        mock_registry_client.consume_eab_credential.return_value = None
        with patch("app.acme.eab_verifier.get_jws_verifier") as mock_get:
            from app.acme.jws_verifier import JWSVerifier

            mock_get.return_value = JWSVerifier()
            with pytest.raises(AcmeException) as exc_info:
                await verify_eab_binding(eab_jws, account_jwk, self._URL, mock_registry_client)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_bad_signature_raises(self, mock_registry_client: MagicMock) -> None:
        account_jwk = _make_account_jwk()
        eab_jws = self._make_eab(corrupt_sig=True, account_jwk=account_jwk)
        mock_registry_client.consume_eab_credential.return_value = (_b64url(self._MAC_KEY), "AIC-001")
        with patch("app.acme.eab_verifier.get_jws_verifier") as mock_get:
            from app.acme.jws_verifier import JWSVerifier

            mock_get.return_value = JWSVerifier()
            with pytest.raises(AcmeException) as exc_info:
                await verify_eab_binding(eab_jws, account_jwk, self._URL, mock_registry_client)
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_empty_kid_raises(self, mock_registry_client: MagicMock) -> None:
        account_jwk = _make_account_jwk()
        eab_jws = self._make_eab(kid="", account_jwk=account_jwk)
        with patch("app.acme.eab_verifier.get_jws_verifier") as mock_get:
            from app.acme.jws_verifier import JWSVerifier

            mock_get.return_value = JWSVerifier()
            with pytest.raises(AcmeException) as exc_info:
                await verify_eab_binding(eab_jws, account_jwk, self._URL, mock_registry_client)
        assert exc_info.value.status_code == 400
