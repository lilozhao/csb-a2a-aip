import json
import uuid
from pathlib import Path
from typing import Annotated, Any, cast

import structlog
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Depends,
    Query,
    Request,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.model import RoleType, User
from app.agent.exception import (
    AccessDeniedNotOwnerError,
    PublicAgentNotFoundError,
    SchemaFileMissingError,
)
from app.agent.model import Agent, ApprovalStatus
from app.agent.schema import (
    AgentBatchDeleteResponse,
    AgentCreate,
    AgentDeleteResponse,
    AgentDetailResponse,
    AgentFilters,
    AgentListQuery,
    AgentListResponse,
    AgentProcessRequest,
    AgentResponse,
    AgentSearchResponse,
    AgentUpdate,
    StaffAgentListQuery,
)
from app.agent.service import (
    batch_delete_agents_async,
    cancel_agent_submission_async,
    create_agent_async,
    create_agent_detail_response,
    create_agent_response,
    delete_agent_async,
    disable_agent_async,
    enable_agent_async,
    generate_jsonc_sample_from_schema,
    process_agent_approval_async,
    submit_agent_for_approval_async,
    update_agent_async,
)
from app.agent.service_query import get_agent_async, get_agents_async, get_recent_agents_async
from app.agent.smtp import get_frontend_url, is_email, send_need_review_mail
from app.agent.smtp import send_code as send_email_code
from app.core.auth import check_user_role
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.core.config import settings
from app.core.db_session import get_session
from app.core.security import limiter
from app.sync.service import trigger_data_change_webhook
from app.utils.utils import parse_boolean_string

logger = structlog.get_logger(__name__)

type SessionDep = Annotated[AsyncSession, Depends(get_session)]
type ClientUserDep = Annotated[User, Depends(check_user_role([RoleType.CLIENT]))]
type StaffUserDep = Annotated[User, Depends(check_user_role([RoleType.STAFF, RoleType.ADMIN]))]
type DeleteReasonBody = Annotated[str, Body(description="删除原因")]
type DisableReasonBody = Annotated[str, Body(description="禁用原因")]
type AgentIdsBody = Annotated[list[uuid.UUID], Body()]
type AgentListQueryParam = Annotated[AgentListQuery, Query()]
type StaffAgentListQueryParam = Annotated[StaffAgentListQuery, Query()]

# 为公开、客户端和工作人员接口分别创建路由
router_public = APIRouter(prefix="/agent/public", tags=["agent-public"])
router_client = APIRouter(prefix="/agent/client", tags=["agent-client"])
router_staff = APIRouter(prefix="/agent/staff", tags=["agent-staff"])


def _problem_response(description: str) -> dict[str, object]:
    return {"description": description, "content": {PROBLEM_JSON_MEDIA_TYPE: {}}}


BAD_REQUEST_RESPONSE = _problem_response("Agent request is invalid")
UNAUTHORIZED_RESPONSE = _problem_response("Authentication required")
FORBIDDEN_RESPONSE = _problem_response("Agent access denied")
NOT_FOUND_RESPONSE = _problem_response("Agent resource not found")
CONFLICT_RESPONSE = _problem_response("Agent resource already exists")
VALIDATION_RESPONSE = _problem_response("Request validation failed")
RATE_LIMIT_RESPONSE = _problem_response("Too many requests")
SERVER_ERROR_RESPONSE = _problem_response("Agent operation failed")


def _create_agent_list_item_response(agent: Agent, with_users: bool) -> AgentDetailResponse:
    if with_users:
        return create_agent_detail_response(agent)

    response = create_agent_response(agent)
    return AgentDetailResponse(**response.model_dump())


def _build_agent_filters_from_query(
    query: AgentListQuery,
    *,
    create_by_id: uuid.UUID | None = None,
    process_by_id: uuid.UUID | None = None,
) -> AgentFilters:
    create_by_ids: list[uuid.UUID] | None = None
    if create_by_id:
        create_by_ids = [create_by_id]
    return AgentFilters(
        page_num=query.page_num,
        page_size=query.page_size,
        statuses=query.statuses,
        name=query.name,
        version=query.version,
        aic=query.aic,
        name_like=query.name_like,
        version_like=query.version_like,
        aic_like=query.aic_like,
        create_by_ids=create_by_ids,
        process_by_id=process_by_id,
        with_users=query.with_users,
        is_active=parse_boolean_string(query.is_active),
        is_deleted=parse_boolean_string(query.is_deleted),
        is_disabled=parse_boolean_string(query.is_disabled),
        is_ontology=query.is_ontology,
        org_name=query.org_name,
    )


def _build_agent_filters_from_query_ids(
    query: AgentListQuery,
    *,
    create_by_ids: list[uuid.UUID] | None = None,
    process_by_id: uuid.UUID | None = None,
) -> AgentFilters:

    return AgentFilters(
        page_num=query.page_num,
        page_size=query.page_size,
        statuses=query.statuses,
        name=query.name,
        version=query.version,
        aic=query.aic,
        name_like=query.name_like,
        version_like=query.version_like,
        aic_like=query.aic_like,
        create_by_ids=create_by_ids,
        process_by_id=process_by_id,
        with_users=query.with_users,
        is_active=parse_boolean_string(query.is_active),
        is_deleted=parse_boolean_string(query.is_deleted),
        is_disabled=parse_boolean_string(query.is_disabled),
        is_ontology=query.is_ontology,
        org_name=query.org_name,
    )


def _build_staff_agent_filters(query: StaffAgentListQuery, current_user_id: uuid.UUID) -> AgentFilters:
    resolved_process_by_id = current_user_id if query.processed_by_me else query.process_by_id
    return _build_agent_filters_from_query(
        query,
        create_by_id=query.create_by_id,
        process_by_id=resolved_process_by_id,
    )


# -------------------------------------------------------------------
# 公开端点 - 无需认证
# -------------------------------------------------------------------


@router_public.post(
    "/send_code",
    status_code=status.HTTP_200_OK,
    summary="发送邮箱验证码",
    responses={
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
def send_code(email: str) -> dict[str, str | bool]:
    """
    发送验证码
    Args:
        email: 邮箱
    """
    if not is_email(email):
        return {
            "status": False,
            "msg": "发送失败",
        }
    try:
        result = send_email_code(email)
        return {
            "status": result,
            "msg": "发送成功" if result else "发送失败",
        }
    except Exception:
        return {
            "status": False,
            "msg": "发送失败",
        }


@router_public.get(
    "/acs_example",
    status_code=status.HTTP_200_OK,
    summary="获取 ACS 示例 JSONC",
    responses={
        status.HTTP_429_TOO_MANY_REQUESTS: RATE_LIMIT_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
@limiter.limit(settings.rate_limit_public_read)
async def get_acs_example(request: Request) -> str:
    """
    获取 ACS (Agent Capability Spec) 的示例 JSONC (带注释)
    """
    del request
    schema_path = Path(__file__).parent / "acsSchema.json"

    if not schema_path.exists():
        raise SchemaFileMissingError()

    with schema_path.open(encoding="utf-8") as f:
        schema = json.load(f)

    jsonc_content, _ = generate_jsonc_sample_from_schema(schema)
    return jsonc_content


@router_public.get(
    "/recent",
    status_code=status.HTTP_200_OK,
    summary="获取最近审批通过的 Agent 列表",
    responses={
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
        status.HTTP_429_TOO_MANY_REQUESTS: RATE_LIMIT_RESPONSE,
    },
)
@limiter.limit(settings.rate_limit_public_read)
async def public_get_recent_approved_agents(
    request: Request,
    db: SessionDep,
    limit: int = 5,
    with_users: bool = False,
) -> AgentSearchResponse:
    """
    获取最近审批通过的 Agent，默认 5 条（公开接口，无需登录）
    - 支持是否加载关联用户数据（创建者和处理者）
    """
    del request
    # 将 with_users 参数传递给 get_recent_agents 函数
    agents = await get_recent_agents_async(db, limit, with_users=with_users)

    # 根据是否加载了用户信息，选择合适的响应构造函数
    items = [_create_agent_list_item_response(agent, with_users=with_users) for agent in agents]

    total = len(items)
    return AgentSearchResponse(items=items, total=total, page_num=1, page_size=limit)


@router_public.get(
    "/{agent_id}",
    status_code=status.HTTP_200_OK,
    summary="公开读取已审批通过的 Agent 详情",
    responses={
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
        status.HTTP_429_TOO_MANY_REQUESTS: RATE_LIMIT_RESPONSE,
    },
)
@limiter.limit(settings.rate_limit_public_read)
async def public_read_agent(
    request: Request,
    agent_id: uuid.UUID,
    db: SessionDep,
) -> AgentDetailResponse:
    """
    公开获取已审批通过的 Agent 详情。
    仅返回已审批通过的 Agent，未审批通过的需使用 client 或 staff 接口。
    """
    del request
    # 详情接口加载完整的用户信息
    agent = await get_agent_async(db, agent_id, with_users=True, raise_exception=True)

    # 公开接口只能访问已审批通过的 Agent
    if agent.approval_status != ApprovalStatus.APPROVED:
        raise PublicAgentNotFoundError(agent_id=str(agent_id))

    return create_agent_detail_response(agent)


# -------------------------------------------------------------------
# 客户端端点 - 仅允许 CLIENT 角色访问（不包含 STAFF 或 ADMIN）
# -------------------------------------------------------------------


@router_client.get(
    "/{agent_id}",
    status_code=status.HTTP_200_OK,
    summary="客户端读取 Agent 详情",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_read_agent(
    agent_id: uuid.UUID,
    db: SessionDep,
    current_user: ClientUserDep,
) -> AgentDetailResponse:
    """
    客户端获取 Agent 详情。
    已审批通过的 Agent 或用户自己创建的 Agent 可以访问。
    仅限 CLIENT 角色访问，STAFF 和 ADMIN 角色不可访问。
    """
    # 详情接口加载完整的用户信息
    agent = await get_agent_async(db, agent_id, with_users=True, raise_exception=True)

    # 已审批通过的 agent 可以访问
    if agent.approval_status == ApprovalStatus.APPROVED:
        return create_agent_detail_response(agent)

    # 未审批通过的 agent 仅限本人访问
    if agent.created_by_id != current_user.id:
        raise AccessDeniedNotOwnerError(agent_id=str(agent_id), request_user_id=str(current_user.id))

    return create_agent_detail_response(agent)


@router_client.post(
    "",
    status_code=status.HTTP_200_OK,
    summary="客户端创建 Agent 草稿",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_409_CONFLICT: CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_create_new_agent(
    agent_create: AgentCreate,
    current_user: ClientUserDep,
    db: SessionDep,
) -> AgentResponse:
    """
    创建新 Agent，保存但不提交审核（仅限 CLIENT 角色）
    """
    agent = await create_agent_async(db, current_user.id, agent_create.model_dump())
    return create_agent_response(agent)


@router_client.get(
    "",
    status_code=status.HTTP_200_OK,
    summary="客户端读取自己的 Agent 列表",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_read_agents(
    db: SessionDep,
    current_user: ClientUserDep,
    filters: AgentListQueryParam,
) -> AgentListResponse:
    """
    获取当前用户的 Agent 列表，普通用户只能查看自己的 Agent
    - 支持按多个状态、名称、版本和协议支持情况过滤
    - 支持是否加载关联用户数据（创建者和处理者）
    - 包含被工作人员禁用但未删除的 Agent
    - 仅限 CLIENT 角色访问
    """
    service_filters = _build_agent_filters_from_query(filters, create_by_id=current_user.id)
    agents, total = await get_agents_async(session=db, filters=service_filters)

    # 根据是否加载了用户信息，选择合适的响应构造函数
    items = [_create_agent_list_item_response(agent, with_users=service_filters.with_users) for agent in agents]

    return AgentListResponse(
        items=items,
        total=total,
        page_num=service_filters.page_num,
        page_size=service_filters.page_size,
    )


@router_client.put(
    "/{agent_id}",
    status_code=status.HTTP_200_OK,
    summary="客户端更新 Agent 草稿",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_update_agent_info(
    agent_id: uuid.UUID,
    agent_update: AgentUpdate,
    db: SessionDep,
    current_user: ClientUserDep,
) -> AgentResponse:
    """
    更新 Agent，审核通过的不能再更新（仅限 CLIENT 角色）
    """
    agent = await update_agent_async(db, agent_id, current_user.id, agent_update.model_dump(exclude_unset=True))
    return create_agent_response(agent)


@router_client.post(
    "/{agent_id}/submit",
    status_code=status.HTTP_200_OK,
    summary="客户端提交 Agent 审核",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_submit_agent(
    agent_id: uuid.UUID,
    request: Request,
    background_tasks: BackgroundTasks,
    db: SessionDep,
    current_user: ClientUserDep,
) -> AgentResponse:
    """
    提交 Agent 进行审核（仅限 CLIENT 角色）
    """
    agent = await submit_agent_for_approval_async(db, agent_id, current_user.id)
    # 发送邮件
    background_tasks.add_task(send_need_review_mail, str(agent_id), agent.name, get_frontend_url(request))
    return create_agent_response(agent)


@router_client.post(
    "/{agent_id}/cancel",
    status_code=status.HTTP_200_OK,
    summary="客户端撤销 Agent 审核申请",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_cancel_agent_submission_request(
    agent_id: uuid.UUID,
    db: SessionDep,
    current_user: ClientUserDep,
) -> AgentResponse:
    """
    撤销处于"审核中"状态的 Agent 申请（仅限 CLIENT 角色）
    """
    agent = await cancel_agent_submission_async(db, agent_id, current_user.id)
    return create_agent_response(agent)


@router_client.delete(
    "/{agent_id}",
    status_code=status.HTTP_200_OK,
    summary="客户端删除单个 Agent",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_delete_agent_record(
    agent_id: uuid.UUID,
    db: SessionDep,
    current_user: ClientUserDep,
    reason: DeleteReasonBody = "User deletion",
) -> AgentDeleteResponse:
    """
    删除 Agent（仅限 CLIENT 角色）
    """
    await delete_agent_async(db, agent_id, current_user.id, reason)
    await db.commit()
    await db.run_sync(lambda sync_session: trigger_data_change_webhook(sync_session, ["acs"]))
    return AgentDeleteResponse(message="Agent deleted successfully")


@router_client.delete(
    "",
    status_code=status.HTTP_200_OK,
    summary="客户端批量删除 Agent",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def client_delete_multiple_agents(
    agent_ids: AgentIdsBody,
    db: SessionDep,
    current_user: ClientUserDep,
) -> AgentBatchDeleteResponse:
    """
    批量删除 Agent（仅限 CLIENT 角色）
    """
    result = await batch_delete_agents_async(db, agent_ids, current_user.id)

    if result["success"]:
        await db.commit()
        await db.run_sync(lambda sync_session: trigger_data_change_webhook(sync_session, ["acs"]))

    return AgentBatchDeleteResponse.model_validate(result)


# -------------------------------------------------------------------
# 工作人员端点 - 需要 STAFF 角色
# -------------------------------------------------------------------


@router_staff.get(
    "/{agent_id}",
    status_code=status.HTTP_200_OK,
    summary="工作人员读取任意 Agent 详情",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def staff_read_agent(
    agent_id: uuid.UUID,
    db: SessionDep,
    current_user: StaffUserDep,
) -> AgentDetailResponse:
    """
    工作人员获取 Agent 详情。工作人员可以查看任何 Agent。
    """
    # 详情接口加载完整的用户信息
    agent = await get_agent_async(db, agent_id, with_users=True, raise_exception=True)
    return create_agent_detail_response(agent)


@router_staff.get(
    "",
    status_code=status.HTTP_200_OK,
    summary="工作人员读取 Agent 列表",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def staff_read_agents(
    db: SessionDep,
    current_user: StaffUserDep,
    filters: StaffAgentListQueryParam,
) -> AgentListResponse:
    """
    工作人员获取 Agent 列表，工作人员可查看所有 Agent
    - 支持按多个状态、名称、版本和协议支持情况过滤
    - 支持按创建者和处理者过滤
    - 支持是否加载关联用户数据（创建者和处理者）
    """
    service_filters = _build_staff_agent_filters(filters, current_user.id)

    create_by_ids: list[uuid.UUID] | None = None
    if service_filters.org_name:
        # 根据组织模糊查询用户
        stmt = select(User).where(func.lower(User.org_name).like(f"%{service_filters.org_name.lower()}%"))
        if current_user.id:
            stmt.where(current_user.id == cast("Any", User.id))
        users_result = await db.execute(stmt)
        users = list(users_result.scalars().all())
        create_by_ids = [user.id for user in users]
        if not create_by_ids:
            return AgentListResponse(
                items=[],
                total=0,
                page_num=service_filters.page_num,
                page_size=service_filters.page_size,
            )
    elif service_filters.create_by_id:
        create_by_ids = [service_filters.create_by_id]

    service_filters.create_by_ids = create_by_ids
    agents, total = await get_agents_async(session=db, filters=service_filters)

    # 根据是否加载了用户信息，选择合适的响应构造函数
    items = [_create_agent_list_item_response(agent, with_users=service_filters.with_users) for agent in agents]

    return AgentListResponse(
        items=items,
        total=total,
        page_num=service_filters.page_num,
        page_size=service_filters.page_size,
    )


@router_staff.post(
    "/{agent_id}/process",
    status_code=status.HTTP_200_OK,
    summary="工作人员审核 Agent",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def staff_process_agent(
    agent_id: uuid.UUID,
    request: AgentProcessRequest,
    db: SessionDep,
    current_user: StaffUserDep,
) -> AgentResponse:
    """
    审核 Agent，设置通过/驳回及审核意见（仅 staff）
    """
    agent = await process_agent_approval_async(db, agent_id, current_user.id, request.approve, request.comments)
    await db.commit()
    if request.approve:
        await db.run_sync(lambda sync_session: trigger_data_change_webhook(sync_session, ["acs"]))
    return create_agent_response(agent)


@router_staff.post(
    "/{agent_id}/disable",
    status_code=status.HTTP_200_OK,
    summary="工作人员禁用 Agent",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def staff_disable_agent(
    agent_id: uuid.UUID,
    db: SessionDep,
    current_user: StaffUserDep,
    reason: DisableReasonBody = "Staff disable",
) -> AgentResponse:
    """
    禁用 Agent（仅限 STAFF 角色）
    """
    agent = await disable_agent_async(db, agent_id, current_user.id, reason)
    await db.commit()
    await db.run_sync(lambda sync_session: trigger_data_change_webhook(sync_session, ["acs"]))
    return create_agent_response(agent)


@router_staff.post(
    "/{agent_id}/enable",
    status_code=status.HTTP_200_OK,
    summary="工作人员启用 Agent",
    responses={
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def staff_enable_agent(
    agent_id: uuid.UUID,
    db: SessionDep,
    current_user: StaffUserDep,
) -> AgentResponse:
    """
    启用被禁用的 Agent（仅限 STAFF 角色）
    """
    agent = await enable_agent_async(db, agent_id, current_user.id)
    await db.commit()
    await db.run_sync(lambda sync_session: trigger_data_change_webhook(sync_session, ["acs"]))
    return create_agent_response(agent)
