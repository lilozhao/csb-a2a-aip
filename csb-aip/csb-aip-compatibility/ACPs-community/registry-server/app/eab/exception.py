from enum import StrEnum
from typing import Any

from fastapi import status

from app.core.base_exception import AppError


class EabErrorCode(StrEnum):
    """EAB 模块错误码。"""

    EAB_NOT_FOUND = "EAB_NOT_FOUND"
    EAB_ALREADY_CONSUMED = "EAB_ALREADY_CONSUMED"
    EAB_EXPIRED = "EAB_EXPIRED"
    AIC_NOT_OWNED = "AIC_NOT_OWNED"
    AIC_INACTIVE = "AIC_INACTIVE"


class EabError(AppError):
    """EAB 相关异常的基类。"""

    def __init__(
        self,
        *,
        code: EabErrorCode,
        title: str,
        detail: str,
        status_code: int = status.HTTP_400_BAD_REQUEST,
        input_params: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            code=code,
            title=title,
            detail=detail,
            type_=f"urn:acps:error:eab:{code.lower()}",
            extensions={
                "error_group": "eab",
                "input_params": input_params or {},
            },
        )


class AgentAicNotOwnedError(EabError):
    """当前用户不拥有目标 AIC 时抛出的异常。"""

    def __init__(self, *, agent_aic: str, user_id: str) -> None:
        super().__init__(
            code=EabErrorCode.AIC_NOT_OWNED,
            title="Agent AIC not owned",
            detail="Agent AIC is not owned by the current user",
            status_code=status.HTTP_403_FORBIDDEN,
            input_params={"agent_aic": agent_aic, "user_id": user_id},
        )


class AgentAicInactiveError(EabError):
    """目标 AIC 处于非 active 状态时抛出的异常。"""

    def __init__(self, *, agent_aic: str) -> None:
        super().__init__(
            code=EabErrorCode.AIC_INACTIVE,
            title="Agent AIC inactive",
            detail="Agent AIC is not active",
            status_code=status.HTTP_403_FORBIDDEN,
            input_params={"agent_aic": agent_aic},
        )


class EabCredentialNotFoundError(EabError):
    """EAB 凭据不存在时抛出的异常。"""

    def __init__(self, *, key_id: str) -> None:
        super().__init__(
            code=EabErrorCode.EAB_NOT_FOUND,
            title="EAB credential not found",
            detail="EAB credential not found",
            status_code=status.HTTP_404_NOT_FOUND,
            input_params={"key_id": key_id},
        )


class EabCredentialAlreadyConsumedError(EabError):
    """EAB 凭据已被消费时抛出的异常。"""

    def __init__(self, *, key_id: str) -> None:
        super().__init__(
            code=EabErrorCode.EAB_ALREADY_CONSUMED,
            title="EAB credential already consumed",
            detail="EAB credential has already been consumed",
            status_code=status.HTTP_400_BAD_REQUEST,
            input_params={"key_id": key_id},
        )


class EabCredentialExpiredError(EabError):
    """EAB 凭据已过期时抛出的异常。"""

    def __init__(self, *, key_id: str) -> None:
        super().__init__(
            code=EabErrorCode.EAB_EXPIRED,
            title="EAB credential expired",
            detail="EAB credential has expired",
            status_code=status.HTTP_400_BAD_REQUEST,
            input_params={"key_id": key_id},
        )
