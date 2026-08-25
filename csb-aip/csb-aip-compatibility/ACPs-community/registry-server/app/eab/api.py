import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.exception_auth import TokenValidationError
from app.account.model import RoleType, User
from app.core.auth import check_user_role, get_optional_token
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.core.config import settings
from app.core.db_session import get_session
from app.eab.schema import EabConsumeRequest, EabConsumeResponse, EabCredentialResponse  # noqa: TC001
from app.eab.service import consume_eab_credential, generate_eab_credential

router_atr = APIRouter(tags=["ATR EAB"])
router_internal = APIRouter(prefix="/internal", tags=["Internal EAB"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
CurrentClientUser = Annotated[User, Depends(check_user_role([RoleType.CLIENT]))]


def require_internal_service_token(request: Request) -> None:
    """校验 internal EAB consume 端点的服务令牌。"""
    token = get_optional_token(request)
    configured_token = settings.registry_server_internal_api_token.strip()

    if not token or not configured_token or not secrets.compare_digest(token, configured_token):
        raise TokenValidationError()


def _problem_response(description: str) -> dict[str, object]:
    return {"description": description, "content": {PROBLEM_JSON_MEDIA_TYPE: {}}}


UNAUTHORIZED_RESPONSE = _problem_response("Authentication required")
FORBIDDEN_RESPONSE = _problem_response("EAB access denied")
NOT_FOUND_RESPONSE = _problem_response("EAB credential not found")
BAD_REQUEST_RESPONSE = _problem_response("Invalid EAB request")
VALIDATION_RESPONSE = _problem_response("Request validation failed")


@router_atr.post(
    "/eab/{agent_aic}",
    status_code=status.HTTP_201_CREATED,
    summary="为指定 Agent 生成一次性 EAB 凭据",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def create_eab_credential(
    agent_aic: str,
    current_user: CurrentClientUser,
    db: DbSession,
) -> EabCredentialResponse:
    """为当前用户拥有且处于 active 状态的 AIC 生成一次性 EAB 凭据。"""
    return await generate_eab_credential(db, current_user.id, agent_aic)


@router_internal.post(
    "/eab/consume",
    status_code=status.HTTP_200_OK,
    summary="消费一次性 EAB 凭据",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def consume_eab_credential_endpoint(
    request: EabConsumeRequest,
    db: DbSession,
    _: None = Depends(require_internal_service_token),
) -> EabConsumeResponse:
    """消费 EAB 凭据，供 CA Server 进行账户绑定校验。"""
    return await consume_eab_credential(db, request.key_id)
