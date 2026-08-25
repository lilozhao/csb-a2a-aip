"""
通用工具函数模块。

此模块包含整个应用程序中使用的通用工具类和函数。
"""

import logging
from typing import ClassVar


class ColoredFormatter(logging.Formatter):
    """带颜色的日志格式化器，只对levelname添加颜色"""

    # ANSI颜色代码
    COLORS: ClassVar[dict[str, str]] = {
        "DEBUG": "\033[36m",  # 青色
        "INFO": "\033[32m",  # 绿色
        "WARNING": "\033[33m",  # 黄色
        "ERROR": "\033[31m",  # 红色
        "CRITICAL": "\033[35m",  # 紫色
        "RESET": "\033[0m",  # 重置颜色
    }

    def format(self, record: logging.LogRecord) -> str:
        """
        格式化日志记录，为levelname添加颜色。

        Args:
            record: 日志记录对象

        Returns:
            str: 格式化后的日志字符串
        """
        # 获取原始格式化结果
        log_message = super().format(record)

        # 为levelname添加颜色
        levelname = record.levelname
        if levelname in self.COLORS:
            colored_levelname = f"{self.COLORS[levelname]}{levelname}{self.COLORS['RESET']}"
            # 替换原始消息中的levelname
            log_message = log_message.replace(f" - {levelname} - ", f" - {colored_levelname} - ")

        return log_message
