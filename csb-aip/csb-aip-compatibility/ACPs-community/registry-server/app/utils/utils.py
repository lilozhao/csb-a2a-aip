import hashlib
from datetime import UTC, datetime, timedelta, timezone


def parse_boolean_string(bool_str: str | None) -> bool | None:
    """
    Convert a string representation to a boolean value or None.

    Args:
        bool_str: String representation of a boolean value

    Returns:
        - True for strings like 'true', '1', 'yes' (case insensitive)
        - False for strings like 'false', '0', 'no' (case insensitive)
        - None for empty strings or None input
    """
    if bool_str is None or bool_str == "":
        return None

    normalized = bool_str.lower()

    if normalized in ("true", "1", "yes", "t"):
        return True
    if normalized in ("false", "0", "no", "f"):
        return False

    return None


# 北京时区（UTC+8）
BEIJING_TIMEZONE = timezone(timedelta(hours=8))


def get_beijing_time() -> datetime:
    """
    获取当前北京时间（UTC+8）。

    Returns:
        带有 tzinfo 的北京时间 datetime 对象
    """
    return datetime.now(BEIJING_TIMEZONE)


def utc_to_beijing(dt: datetime) -> datetime:
    """
    将 UTC datetime 转换为北京时间（UTC+8）。

    Args:
        dt: 待转换的 datetime 对象（可带或不带 tzinfo）

    Returns:
        带有 tzinfo 的北京时间 datetime 对象
    """
    # 若 datetime 不带时区信息，则默认视为 UTC
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)

    # 转换为北京时间
    return dt.astimezone(BEIJING_TIMEZONE)


def beijing_to_utc(dt: datetime) -> datetime:
    """
    将北京时间 datetime 转换为 UTC。

    Args:
        dt: 待转换的 datetime 对象（可带或不带 tzinfo）

    Returns:
        带有 tzinfo 的 UTC datetime 对象
    """
    # 若 datetime 不带时区信息，则默认视为北京时间
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING_TIMEZONE)

    # 转换为 UTC
    return dt.astimezone(UTC)


def sha256(text: str) -> str:
    """
    计算输入文本的 SHA256 哈希，并返回十六进制字符串。

    Args:
        text: 待计算哈希的输入文本

    Returns:
        十六进制字符串形式的 SHA256 哈希值
    """
    if not text:
        return ""

    # 将文本编码为字节后计算 SHA256 哈希
    hash_object = hashlib.sha256(text.encode("utf-8"))
    # 返回十六进制表示
    return hash_object.hexdigest()
