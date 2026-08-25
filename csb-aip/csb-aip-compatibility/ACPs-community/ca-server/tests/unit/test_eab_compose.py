"""测试 EAB 辅助函数（app.acme.eab_verifier）。"""

from __future__ import annotations

import pytest

from app.acme.eab_verifier import _compose_jws_string
from app.acme.exception import AcmeError, AcmeException


class TestComposeJWSString:
    def test_valid_dict_returns_dot_separated_string(self) -> None:
        eab_jws = {
            "protected": "protectedValue",
            "payload": "payloadValue",
            "signature": "signatureValue",
        }
        result = _compose_jws_string(eab_jws)
        assert result == "protectedValue.payloadValue.signatureValue"

    def test_missing_protected_raises(self) -> None:
        with pytest.raises(AcmeException) as exc_info:
            _compose_jws_string({"payload": "p", "signature": "s"})
        assert exc_info.value.error_name == AcmeError.MALFORMED_REQUEST

    def test_missing_payload_raises(self) -> None:
        with pytest.raises(AcmeException) as exc_info:
            _compose_jws_string({"protected": "h", "signature": "s"})
        assert exc_info.value.error_name == AcmeError.MALFORMED_REQUEST

    def test_missing_signature_raises(self) -> None:
        with pytest.raises(AcmeException) as exc_info:
            _compose_jws_string({"protected": "h", "payload": "p"})
        assert exc_info.value.error_name == AcmeError.MALFORMED_REQUEST

    def test_empty_dict_raises(self) -> None:
        with pytest.raises(AcmeException) as exc_info:
            _compose_jws_string({})
        assert exc_info.value.error_name == AcmeError.MALFORMED_REQUEST

    def test_status_code_is_400(self) -> None:
        with pytest.raises(AcmeException) as exc_info:
            _compose_jws_string({"protected": "h", "payload": "p"})
        assert exc_info.value.status_code == 400

    def test_extra_keys_ignored(self) -> None:
        eab_jws = {
            "protected": "h",
            "payload": "p",
            "signature": "s",
            "extra_key": "ignored",
        }
        result = _compose_jws_string(eab_jws)
        assert result == "h.p.s"

    def test_non_string_values_coerced_to_str(self) -> None:
        eab_jws = {
            "protected": 123,
            "payload": None,
            "signature": b"bytes",
        }
        result = _compose_jws_string(eab_jws)
        assert result == "123.None.b'bytes'"
