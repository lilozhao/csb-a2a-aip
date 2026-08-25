from enum import StrEnum
from typing import Any

from fastapi import status

from app.core.base_exception import AppError


class VerificationErrorCode(StrEnum):
    """审核模块错误码。"""

    IDENTITY_ALREADY_VERIFIED = "IDENTITY_ALREADY_VERIFIED"
    IDENTITY_PENDING = "IDENTITY_PENDING"
    ORG_ALREADY_VERIFIED = "ORG_ALREADY_VERIFIED"
    ORG_PENDING = "ORG_PENDING"
    IDENTITY_NOT_VERIFIED = "IDENTITY_NOT_VERIFIED"


class VerificationError(AppError):
    """审核相关异常的基类。"""

    def __init__(
        self,
        *,
        code: VerificationErrorCode,
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
            type_=f"urn:acps:error:verification:{code.lower()}",
            extensions={
                "error_group": "verification",
                "input_params": input_params or {},
            },
        )


class IdentityAlreadyVerifiedError(VerificationError):
    """身份审核已经成功时抛出的异常。"""

    def __init__(self, *, user_id: str) -> None:
        super().__init__(
            code=VerificationErrorCode.IDENTITY_ALREADY_VERIFIED,
            title="Identity already verified",
            detail="Identity is already verified",
            status_code=status.HTTP_409_CONFLICT,
            input_params={"user_id": user_id},
        )


class IdentityVerificationPendingError(VerificationError):
    """身份审核已经处于待处理状态时抛出的异常。"""

    def __init__(self, *, user_id: str, verification_id: str) -> None:
        super().__init__(
            code=VerificationErrorCode.IDENTITY_PENDING,
            title="Identity verification pending",
            detail="Identity verification is already pending",
            status_code=status.HTTP_409_CONFLICT,
            input_params={"user_id": user_id, "verification_id": verification_id},
        )


class IdentityVerificationRequiredError(VerificationError):
    """在身份审核完成前请求组织审核时抛出的异常。"""

    def __init__(self, *, user_id: str) -> None:
        super().__init__(
            code=VerificationErrorCode.IDENTITY_NOT_VERIFIED,
            title="Identity verification required",
            detail="Identity verification is required before organization verification",
            status_code=status.HTTP_403_FORBIDDEN,
            input_params={"user_id": user_id},
        )


class OrganizationAlreadyVerifiedError(VerificationError):
    """组织审核已经成功时抛出的异常。"""

    def __init__(self, *, user_id: str) -> None:
        super().__init__(
            code=VerificationErrorCode.ORG_ALREADY_VERIFIED,
            title="Organization already verified",
            detail="Organization is already verified",
            status_code=status.HTTP_409_CONFLICT,
            input_params={"user_id": user_id},
        )


class OrganizationVerificationPendingError(VerificationError):
    """组织审核已经处于待处理状态时抛出的异常。"""

    def __init__(self, *, user_id: str, verification_id: str) -> None:
        super().__init__(
            code=VerificationErrorCode.ORG_PENDING,
            title="Organization verification pending",
            detail="Organization verification is already pending",
            status_code=status.HTTP_409_CONFLICT,
            input_params={"user_id": user_id, "verification_id": verification_id},
        )
