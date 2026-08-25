"""时间处理相关的工具函数"""

from datetime import datetime, timedelta, timezone

BEIJING_TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")


def beijing_now() -> datetime:
    """获取当前北京时间（带时区信息）"""

    return datetime.now(BEIJING_TZ)


def beijing_end_of_day() -> datetime:
    """获取当日北京时间的结束时间（23:59:59）"""

    return beijing_now().replace(hour=23, minute=59, second=59, microsecond=0)


def format_datetime(dt: datetime) -> str:
    """
    格式化datetime为ISO格式字符串。如果输入为naive，会自动补充北京时间时区。

    Args:
        dt: 要格式化的datetime对象

    Returns:
        str: ISO格式的时间字符串
    """

    dt = dt.replace(tzinfo=BEIJING_TZ) if dt.tzinfo is None else dt.astimezone(BEIJING_TZ)
    return dt.isoformat()


def is_expired(expires_at: datetime) -> bool:
    """
    检查是否已过期

    Args:
        expires_at: 过期时间

    Returns:
        bool: 是否已过期
    """
    return beijing_now() > expires_at


def days_until_expiry(expires_at: datetime) -> int:
    """
    计算距离过期还有多少天

    Args:
        expires_at: 过期时间

    Returns:
        int: 剩余天数，负数表示已过期
    """
    delta = expires_at - beijing_now()
    return delta.days
