"""
JWS (JSON Web Signature) 验证服务

实现 ACME 协议所需的 JWS 签名验证功能
"""

import base64
import hashlib
import json
from typing import Any

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from .exception import AcmeError, AcmeException


class JWSVerifier:
    """JWS 签名验证器"""

    @staticmethod
    def base64url_decode(data: str) -> bytes:
        """Base64URL 解码"""
        # 添加必要的填充
        padding_needed = 4 - (len(data) % 4)
        if padding_needed != 4:
            data += "=" * padding_needed

        try:
            return base64.urlsafe_b64decode(data.encode("ascii"))
        except Exception as e:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg=f"Invalid base64url encoding: {e!s}",
            ) from e

    @staticmethod
    def base64url_encode(data: bytes) -> str:
        """Base64URL 编码"""
        return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

    def parse_jws(self, jws_data: str) -> tuple[dict[str, Any], dict[str, Any], str]:
        """解析 JWS 数据

        Returns:
            Tuple[protected_header, payload, signature]
        """
        try:
            # 分割 JWS 组件
            parts = jws_data.split(".")
            if len(parts) != 3:
                raise ValueError("JWS must have exactly 3 parts")

            protected_b64, payload_b64, signature_b64 = parts

            # 解码 protected header
            protected_bytes = self.base64url_decode(protected_b64)
            protected_header = json.loads(protected_bytes.decode("utf-8"))

            # 解码 payload
            if payload_b64 == "":
                payload = {}
            else:
                payload_bytes = self.base64url_decode(payload_b64)
                payload = json.loads(payload_bytes.decode("utf-8"))

            return protected_header, payload, signature_b64

        except json.JSONDecodeError as e:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg=f"Invalid JSON in JWS: {e!s}",
            ) from e
        except Exception as e:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg=f"Invalid JWS format: {e!s}",
            ) from e

    def verify_jws_signature(
        self,
        jws_data: str,
        public_key_jwk: dict[str, Any],
        expected_nonce: str | None = None,
        expected_url: str | None = None,
    ) -> dict[str, Any]:
        """验证 JWS 签名

        Args:
            jws_data: JWS 数据字符串
            public_key_jwk: 公钥 JWK 格式
            expected_nonce: 期望的 nonce 值
            expected_url: 期望的 URL

        Returns:
            验证后的 payload
        """
        # 解析 JWS
        protected_header, payload, signature_b64 = self.parse_jws(jws_data)

        # 验证 protected header
        self._verify_protected_header(protected_header, public_key_jwk, expected_nonce, expected_url)

        # 验证签名
        alg = protected_header["alg"]
        self._verify_signature(jws_data, public_key_jwk, signature_b64, alg)

        return payload

    def _verify_protected_header(
        self,
        protected_header: dict[str, Any],
        public_key_jwk: dict[str, Any],
        expected_nonce: str | None = None,
        expected_url: str | None = None,
    ) -> None:
        """验证 protected header"""
        # 检查必需字段
        if "alg" not in protected_header:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg="Missing 'alg' in protected header",
            )

        # 检查算法
        alg = protected_header["alg"]
        if alg not in ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"]:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.UNSUPPORTED_ALGORITHM,
                error_msg=f"Unsupported algorithm: {alg}",
            )

        # 验证 nonce
        if expected_nonce:
            if "nonce" not in protected_header:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.BAD_NONCE,
                    error_msg="Missing nonce in protected header",
                )

            if protected_header["nonce"] != expected_nonce:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.BAD_NONCE,
                    error_msg="Invalid nonce",
                )

        # 验证 URL
        if expected_url:
            if "url" not in protected_header:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.MALFORMED,
                    error_msg="Missing URL in protected header",
                )

            if protected_header["url"] != expected_url:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.MALFORMED,
                    error_msg=f"URL mismatch: expected {expected_url}, got {protected_header['url']}",
                )

        # 验证 JWK 或 kid
        if "jwk" in protected_header:
            # 验证提供的 JWK 与期望的匹配
            if protected_header["jwk"] != public_key_jwk:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.MALFORMED,
                    error_msg="JWK in protected header does not match account key",
                )
        elif "kid" in protected_header:
            # 对于已有账户，应该使用 kid 而不是 jwk
            pass
        else:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg="Protected header must contain either 'jwk' or 'kid'",
            )

    def _verify_signature(
        self,
        jws_data: str,
        public_key_jwk: dict[str, Any],
        signature_b64: str,
        alg: str = "RS256",
    ) -> None:
        """验证 JWS 签名"""
        # 分割 JWS 获取签名部分
        parts = jws_data.split(".")
        signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")

        # 解码签名
        signature = self.base64url_decode(signature_b64)

        # 从 JWK 构建公钥
        public_key = self._jwk_to_public_key(public_key_jwk)

        # 确定哈希算法
        hash_alg: hashes.HashAlgorithm
        if alg in ["RS256", "ES256"]:
            hash_alg = hashes.SHA256()
        elif alg in ["RS384", "ES384"]:
            hash_alg = hashes.SHA384()
        elif alg in ["RS512", "ES512"]:
            hash_alg = hashes.SHA512()
        else:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.UNSUPPORTED_ALGORITHM,
                error_msg=f"Unsupported algorithm: {alg}",
            )

        # 验证签名
        try:
            if alg.startswith("RS"):
                if not isinstance(public_key, rsa.RSAPublicKey):
                    raise AcmeException(
                        status_code=400,
                        error_name=AcmeError.MALFORMED,
                        error_msg="Key type mismatch: expected RSA key",
                    )
                public_key.verify(signature, signing_input, padding.PKCS1v15(), hash_alg)
            elif alg.startswith("ES"):
                if not isinstance(public_key, ec.EllipticCurvePublicKey):
                    raise AcmeException(
                        status_code=400,
                        error_name=AcmeError.MALFORMED,
                        error_msg="Key type mismatch: expected EC key",
                    )

                # JWS 使用 Raw (R||S) 格式，cryptography 需要 DER 格式
                try:
                    # 计算坐标长度 (签名长度的一半)
                    coord_len = len(signature) // 2
                    r_bytes = signature[:coord_len]
                    s_bytes = signature[coord_len:]

                    r = int.from_bytes(r_bytes, byteorder="big")
                    s = int.from_bytes(s_bytes, byteorder="big")

                    der_signature = encode_dss_signature(r, s)
                    public_key.verify(der_signature, signing_input, ec.ECDSA(hash_alg))
                except Exception as e:
                    raise AcmeException(
                        status_code=400,
                        error_name=AcmeError.MALFORMED,
                        error_msg=f"Invalid EC signature format: {e!s}",
                    ) from e
        except AcmeException:
            raise
        except Exception as e:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg=f"Invalid signature: {e!s}",
            ) from e

    def _jwk_to_public_key(self, jwk: dict[str, Any]) -> rsa.RSAPublicKey | ec.EllipticCurvePublicKey:
        """将 JWK 转换为公钥对象"""
        kty = jwk.get("kty")

        if kty == "RSA":
            try:
                # 解码 n 和 e
                n_bytes = self.base64url_decode(jwk["n"])
                e_bytes = self.base64url_decode(jwk["e"])

                # 将字节转换为整数
                n = int.from_bytes(n_bytes, byteorder="big")
                e = int.from_bytes(e_bytes, byteorder="big")

                # 构建 RSA 公钥
                rsa_public_numbers = rsa.RSAPublicNumbers(e, n)
                return rsa_public_numbers.public_key(backend=default_backend())
            except Exception as e:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.MALFORMED,
                    error_msg=f"Invalid RSA JWK format: {e!s}",
                ) from e

        elif kty == "EC":
            try:
                crv = jwk["crv"]
                x_bytes = self.base64url_decode(jwk["x"])
                y_bytes = self.base64url_decode(jwk["y"])

                x = int.from_bytes(x_bytes, byteorder="big")
                y = int.from_bytes(y_bytes, byteorder="big")

                if crv == "P-256":
                    curve: ec.EllipticCurve = ec.SECP256R1()
                elif crv == "P-384":
                    curve = ec.SECP384R1()
                elif crv == "P-521":
                    curve = ec.SECP521R1()
                else:
                    raise AcmeException(
                        status_code=400,
                        error_name=AcmeError.UNSUPPORTED_ALGORITHM,
                        error_msg=f"Unsupported curve: {crv}",
                    )

                ec_public_numbers = ec.EllipticCurvePublicNumbers(x, y, curve)
                return ec_public_numbers.public_key(backend=default_backend())
            except AcmeException:
                raise
            except Exception as e:
                raise AcmeException(
                    status_code=400,
                    error_name=AcmeError.MALFORMED,
                    error_msg=f"Invalid EC JWK format: {e!s}",
                ) from e

        else:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.UNSUPPORTED_ALGORITHM,
                error_msg=f"Unsupported key type: {kty}",
            )

    def compute_jwk_thumbprint(self, jwk: dict[str, Any]) -> str:
        """计算 JWK 指纹"""
        kty = jwk.get("kty")

        if kty == "RSA":
            # 创建规范化的 JWK
            canonical_jwk = {"e": jwk["e"], "kty": jwk["kty"], "n": jwk["n"]}
        elif kty == "EC":
            # 创建规范化的 JWK
            canonical_jwk = {
                "crv": jwk["crv"],
                "kty": jwk["kty"],
                "x": jwk["x"],
                "y": jwk["y"],
            }
        else:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.UNSUPPORTED_ALGORITHM,
                error_msg=f"Unsupported key type: {kty}",
            )

        # 转换为 JSON 并计算 SHA256
        canonical_json = json.dumps(canonical_jwk, separators=(",", ":"), sort_keys=True)
        hash_bytes = hashlib.sha256(canonical_json.encode("utf-8")).digest()

        return self.base64url_encode(hash_bytes)


# 全局 JWS 验证器实例
_jws_verifier: JWSVerifier | None = None


def get_jws_verifier() -> JWSVerifier:
    """获取 JWS 验证器实例"""
    global _jws_verifier
    if _jws_verifier is None:
        _jws_verifier = JWSVerifier()
    return _jws_verifier
