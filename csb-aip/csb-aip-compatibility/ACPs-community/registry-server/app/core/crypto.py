import base64
import secrets

from gmssl import func, sm3
from gmssl.sm4 import SM4_DECRYPT, SM4_ENCRYPT, CryptSM4

SM4_BLOCK_SIZE = 16


def _normalize_sm4_key(key_hex: str) -> bytes:
    normalized = key_hex.removeprefix("0x").removeprefix("0X")
    if len(normalized) != 32:
        raise ValueError("SM4 key must be exactly 16 bytes represented as 32 hex chars")
    return bytes.fromhex(normalized)


def _pkcs7_pad(data: bytes, block_size: int = SM4_BLOCK_SIZE) -> bytes:
    padding_length = block_size - (len(data) % block_size)
    return data + bytes([padding_length]) * padding_length


def _pkcs7_unpad(data: bytes, block_size: int = SM4_BLOCK_SIZE) -> bytes:
    if not data or len(data) % block_size != 0:
        raise ValueError("Invalid SM4 ciphertext length")

    padding_length = data[-1]
    if padding_length < 1 or padding_length > block_size:
        raise ValueError("Invalid SM4 padding")

    padding = data[-padding_length:]
    if padding != bytes([padding_length]) * padding_length:
        raise ValueError("Invalid SM4 padding")

    return data[:-padding_length]


def _urlsafe_b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _urlsafe_b64decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def sm4_encrypt(plaintext: str, key_hex: str) -> str:
    """使用 SM4-CBC 加密明文，并返回 URL-safe Base64 文本。"""
    key = _normalize_sm4_key(key_hex)
    iv = secrets.token_bytes(SM4_BLOCK_SIZE)
    crypt_sm4 = CryptSM4()
    crypt_sm4.set_key(key, SM4_ENCRYPT)
    ciphertext = crypt_sm4.crypt_cbc(iv, _pkcs7_pad(plaintext.encode("utf-8")))
    return _urlsafe_b64encode(iv + ciphertext)


def sm4_decrypt(ciphertext: str, key_hex: str) -> str:
    """解密经过 URL-safe Base64 编码的 SM4-CBC 密文。"""
    key = _normalize_sm4_key(key_hex)
    raw = _urlsafe_b64decode(ciphertext)
    if len(raw) < SM4_BLOCK_SIZE:
        raise ValueError("Invalid SM4 payload")

    iv = raw[:SM4_BLOCK_SIZE]
    payload = raw[SM4_BLOCK_SIZE:]
    crypt_sm4 = CryptSM4()
    crypt_sm4.set_key(key, SM4_DECRYPT)
    plaintext = crypt_sm4.crypt_cbc(iv, payload)
    return _pkcs7_unpad(plaintext).decode("utf-8")


def sm3_hash(value: str, salt: str) -> str:
    """使用调用方提供的盐值对内容进行 SM3 哈希。"""
    data = f"{salt}:{value}".encode()
    return str(sm3.sm3_hash(func.bytes_to_list(data)))


def generate_sm3_salt(length: int = 16) -> str:
    """生成用于 SM3 哈希的随机十六进制盐值。"""
    return secrets.token_hex(length)
