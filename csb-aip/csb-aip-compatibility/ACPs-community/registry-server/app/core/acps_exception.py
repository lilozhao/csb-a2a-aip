from typing import Any


class AcpsError(Exception):
    """ACPs 协议族 API 的基础异常类型。"""

    def __init__(
        self,
        *,
        protocol: str,
        code: int,
        message: str,
        http_status: int = 400,
        data: dict[str, Any] | None = None,
    ) -> None:
        self.protocol = protocol
        self.code = code
        self.message = message
        self.http_status = http_status
        self.data = data or None
        super().__init__(message)

    def to_response_payload(self) -> dict[str, Any]:
        """返回符合 ATR CommonResponse 错误结构的响应载荷。"""
        return {
            "status": "error",
            "error": {
                "code": self.code,
                "message": self.message,
                "data": self.data,
            },
        }
