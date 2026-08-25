"""
ACME 工具函数

提供 ACME 协议相关的工具函数，包括 JWS 验证、密钥处理等。
"""

import base64
import hashlib
import json
import secrets
from typing import Any

from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi.responses import JSONResponse

from .exception import AcmeError, AcmeException


def base64url_decode(data: str) -> bytes:
    """Base64URL 解码"""
    # 添加必要的填充
    padding_length = 4 - (len(data) % 4)
    if padding_length != 4:
        data += "=" * padding_length

    return base64.urlsafe_b64decode(data)


def base64url_encode(data: bytes) -> str:
    """Base64URL 编码"""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def jwk_to_public_key(jwk: dict[str, Any]) -> rsa.RSAPublicKey | ec.EllipticCurvePublicKey:
    """将 JWK 转换为 cryptography 公钥对象"""
    kty = jwk.get("kty")

    if kty == "RSA":
        try:
            # 解码 RSA 参数
            n = int.from_bytes(base64url_decode(jwk["n"]), byteorder="big")
            e = int.from_bytes(base64url_decode(jwk["e"]), byteorder="big")

            # 创建公钥
            rsa_public_numbers = rsa.RSAPublicNumbers(e, n)
            return rsa_public_numbers.public_key(backend=default_backend())
        except (ValueError, TypeError, KeyError) as e:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.BAD_SIGNATURE,
                error_msg=f"Invalid RSA JWK: {e!s}",
            ) from e

    elif kty == "EC":
        try:
            crv = jwk["crv"]
            x = int.from_bytes(base64url_decode(jwk["x"]), byteorder="big")
            y = int.from_bytes(base64url_decode(jwk["y"]), byteorder="big")

            if crv == "P-256":
                curve: ec.EllipticCurve = ec.SECP256R1()
            elif crv == "P-384":
                curve = ec.SECP384R1()
            elif crv == "P-521":
                curve = ec.SECP521R1()
            else:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.BAD_SIGNATURE,
                    error_msg=f"Unsupported curve: {crv}",
                )

            ec_public_numbers = ec.EllipticCurvePublicNumbers(x, y, curve)
            return ec_public_numbers.public_key(backend=default_backend())
        except AcmeException:
            raise
        except (ValueError, TypeError, KeyError) as e:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.BAD_SIGNATURE,
                error_msg=f"Invalid EC JWK: {e!s}",
            ) from e

    else:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.BAD_SIGNATURE,
            error_msg=f"Unsupported key type: {kty}",
        )


def verify_jws_signature(protected: str, payload: str, signature: str, jwk: dict[str, Any]) -> bool:
    """验证 JWS 签名"""
    try:
        # 获取公钥
        public_key = jwk_to_public_key(jwk)

        # 构造签名数据
        signing_input = f"{protected}.{payload}".encode("ascii")

        # 解码签名
        signature_bytes = base64url_decode(signature)

        # 验证签名
        if isinstance(public_key, rsa.RSAPublicKey):
            public_key.verify(signature_bytes, signing_input, padding.PKCS1v15(), hashes.SHA256())
        else:
            coord_len = len(signature_bytes) // 2
            r_bytes = signature_bytes[:coord_len]
            s_bytes = signature_bytes[coord_len:]
            der_signature = encode_dss_signature(
                int.from_bytes(r_bytes, byteorder="big"),
                int.from_bytes(s_bytes, byteorder="big"),
            )
            public_key.verify(der_signature, signing_input, ec.ECDSA(hashes.SHA256()))

        return True

    except Exception:  # 保留广捕获：cryptography 库的签名验证可能抛出多种异常，实正错序序处理为简单返回 False
        return False


def compute_jwk_thumbprint(jwk: dict[str, Any]) -> str:
    """计算 JWK 指纹"""
    if jwk.get("kty") == "RSA":
        # 提取必要字段并排序
        canonical = {"e": jwk["e"], "kty": jwk["kty"], "n": jwk["n"]}
    else:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.BAD_SIGNATURE,
            error_msg="Unsupported key type",
        )

    # 转为规范 JSON
    canonical_json = json.dumps(canonical, separators=(",", ":"), sort_keys=True)

    # 计算 SHA256 哈希
    hash_bytes = hashlib.sha256(canonical_json.encode("utf-8")).digest()

    return base64url_encode(hash_bytes)


def create_key_authorization(token: str, jwk: dict[str, Any]) -> str:
    """创建密钥授权字符串"""
    thumbprint = compute_jwk_thumbprint(jwk)
    return f"{token}.{thumbprint}"


def parse_protected_header(protected_b64: str) -> dict[str, Any]:
    """解析 JWS protected header"""
    try:
        protected_data = base64url_decode(protected_b64)
        protected_header = json.loads(protected_data.decode("utf-8"))
        if not isinstance(protected_header, dict):
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED_REQUEST,
                error_msg="Protected header must be a JSON object",
            )
        return protected_header
    except AcmeException:
        raise
    except (ValueError, UnicodeDecodeError, KeyError) as e:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.MALFORMED_REQUEST,
            error_msg=f"Invalid protected header: {e!s}",
        ) from e


def parse_payload(payload_b64: str) -> dict[str, Any]:
    """解析 JWS payload"""
    try:
        if not payload_b64:
            return {}

        payload_data = base64url_decode(payload_b64)
        payload = json.loads(payload_data.decode("utf-8"))
        if not isinstance(payload, dict):
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED_REQUEST,
                error_msg="Payload must be a JSON object",
            )
        return payload
    except AcmeException:
        raise
    except (ValueError, UnicodeDecodeError, KeyError) as e:
        raise AcmeException(
            status_code=400,
            error_name=AcmeError.MALFORMED_REQUEST,
            error_msg=f"Invalid payload: {e!s}",
        ) from e


def validate_contact_list(contact: list[Any]) -> bool:
    """验证联系人列表格式"""
    if not isinstance(contact, list):
        return False

    for contact_info in contact:
        if not isinstance(contact_info, str):
            return False

        # 验证邮箱格式
        if contact_info.startswith("mailto:"):
            email = contact_info[7:]  # 移除 'mailto:' 前缀
            if "@" not in email or "." not in email.split("@")[1]:
                return False
        else:
            # 其他类型的联系方式可以在这里添加验证
            return False

    return True


def format_acme_error(error_type: str, detail: str, instance: str | None = None) -> dict[str, Any]:
    """格式化 ACME 错误响应"""
    error = {"type": f"urn:ietf:params:acme:error:{error_type}", "detail": detail}

    if instance:
        error["instance"] = instance

    return error


def generate_token() -> str:
    """生成随机令牌"""
    return base64url_encode(secrets.token_bytes(32))


def is_valid_identifier(identifier: dict[str, str]) -> bool:
    """验证标识符格式"""
    if not isinstance(identifier, dict):
        return False

    if "type" not in identifier or "value" not in identifier:
        return False

    # Agent CA 只支持 'agent' 类型的标识符
    if identifier["type"] != "agent":
        return False

    # 验证 Agent ID 格式（可以根据实际需求调整）
    agent_id = identifier["value"]
    return isinstance(agent_id, str) and len(agent_id) > 0


def extract_account_url_id(account_url: str) -> int | None:
    """从账户 URL 中提取账户 ID"""
    try:
        # 期望格式: /api/v1/acme/acct/{account_id}
        parts = account_url.split("/")
        if len(parts) >= 2 and parts[-2] == "acct":
            return int(parts[-1])
        return None
    except ValueError, IndexError:
        return None


def build_acme_url(base_url: str, endpoint: str, resource_id: str | None = None) -> str:
    """构建 ACME URL"""
    url = f"{base_url}/{endpoint}"
    if resource_id:
        url = f"{url}/{resource_id}"
    return url


def validate_csr_format(csr_b64: str) -> bool:
    """验证 CSR 格式"""
    try:
        csr_der = base64url_decode(csr_b64)
        x509.load_der_x509_csr(csr_der)
        return True
    except Exception:  # 保留广捕获：x509 CSR 格式检查可能抛出多种异常，验证执丑简化为突简 True/False
        return False


class ACMEResponse:
    """ACME 响应构建器"""

    def __init__(self, data: dict[str, Any], status_code: int = 200):
        self.data = data
        self.status_code = status_code
        self.headers = {"Cache-Control": "no-store", "Content-Type": "application/json"}

    def add_nonce(self, nonce: str) -> ACMEResponse:
        """添加 Replay-Nonce 头"""
        self.headers["Replay-Nonce"] = nonce
        return self

    def add_location(self, location: str) -> ACMEResponse:
        """添加 Location 头"""
        self.headers["Location"] = location
        return self

    def add_link(self, link: str) -> ACMEResponse:
        """添加 Link 头"""
        self.headers["Link"] = link
        return self

    def to_json_response(self) -> JSONResponse:
        """转换为 JSONResponse"""
        return JSONResponse(content=self.data, status_code=self.status_code, headers=self.headers)
