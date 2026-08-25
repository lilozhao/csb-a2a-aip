"""ACME new-account 的 EAB 校验辅助函数。

Agent CA 认证的主体是 AIC，而不是域名控制权。EAB 校验成功后，账户公钥会与
已确认的 AIC 绑定；后续订单流程据此确认 account 已具备对应 AIC 的签发资格。
"""

import hashlib
import hmac
from typing import Any, Protocol

from .exception import AcmeError, AcmeException
from .jws_verifier import get_jws_verifier
from .service import JWKService


class EabCredentialProvider(Protocol):
    """提供 EAB 凭据消费能力的协议接口"""

    async def consume_eab_credential(self, key_id: str) -> tuple[str, str] | None:
        """消费 EAB 凭据，返回 (mac_key, aic) 或 None"""
        ...


def _compose_jws_string(eab_jws: dict[str, Any]) -> str:
    try:
        protected = str(eab_jws["protected"])
        payload = str(eab_jws["payload"])
        signature = str(eab_jws["signature"])
    except KeyError as exc:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.MALFORMED_REQUEST,
            error_msg=f"Missing EAB JWS field: {exc.args[0]}",
        ) from exc
    return f"{protected}.{payload}.{signature}"


async def verify_eab_binding(
    eab_jws: dict[str, Any],
    account_jwk: dict[str, Any],
    expected_url: str,
    registry_client: EabCredentialProvider,
) -> str:
    """验证 externalAccountBinding，并返回与 account 绑定的 AIC。

    该返回值是 Agent CA 的核心认证结果：账户一旦通过 EAB 绑定到某个 AIC，后续
    ACME 流程只需校验订单中的 agent identifier 是否仍归属于同一 AIC，无需再执行
    独立的 ACME challenge 质询。
    """
    jws_verifier = get_jws_verifier()
    jws_string = _compose_jws_string(eab_jws)
    protected, payload, signature_b64 = jws_verifier.parse_jws(jws_string)

    if protected.get("alg") != "HS256":
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.UNSUPPORTED_ALGORITHM,
            error_msg="externalAccountBinding must use HS256",
        )

    if protected.get("url") != expected_url:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.MALFORMED_REQUEST,
            error_msg="externalAccountBinding URL mismatch",
        )

    key_id = protected.get("kid")
    if not isinstance(key_id, str) or not key_id.strip():
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.MALFORMED_REQUEST,
            error_msg="externalAccountBinding missing kid",
        )

    payload_thumbprint = JWKService.compute_jwk_thumbprint(payload)
    account_thumbprint = JWKService.compute_jwk_thumbprint(account_jwk)
    if payload_thumbprint != account_thumbprint:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.MALFORMED_REQUEST,
            error_msg="externalAccountBinding payload does not match account jwk",
        )

    consume_result = await registry_client.consume_eab_credential(key_id)
    if not consume_result:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.EXTERNAL_ACCOUNT_REQUIRED,
            error_msg="Failed to consume external account binding credential",
        )

    mac_key, aic = consume_result
    mac_key_bytes = jws_verifier.base64url_decode(mac_key)
    signing_input = f"{eab_jws['protected']}.{eab_jws['payload']}".encode("ascii")
    expected_signature = hmac.new(
        mac_key_bytes,
        signing_input,
        hashlib.sha256,
    ).digest()
    actual_signature = jws_verifier.base64url_decode(signature_b64)

    if not hmac.compare_digest(expected_signature, actual_signature):
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.BAD_SIGNATURE,
            error_msg="Invalid externalAccountBinding signature",
        )

    return aic
