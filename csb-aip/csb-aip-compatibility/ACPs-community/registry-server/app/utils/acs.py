import json
from pathlib import Path
from typing import Any
from urllib.parse import ParseResult, urlparse

import structlog
from fastapi import status
from jsonschema import ValidationError
from jsonschema import validate as json_validate

from app.agent.exception import AgentError, AgentErrorCode

logger = structlog.get_logger(__name__)

type JsonObject = dict[str, Any]


_TRANSPORT_SCHEME_MAP: dict[str, set[str]] = {
    "AMQP": {"amqp", "amqps"},
    "GRPC": {"grpc", "grpcs", "http", "https"},
    "HTTP_JSON": {"http", "https"},
    "JSONRPC": {"http", "https"},
    "REST": {"http", "https"},
}


def _parse_endpoint_url(url: str) -> ParseResult:
    parsed_url = urlparse(url)
    if not parsed_url.scheme or not parsed_url.netloc:
        raise ValueError("Invalid URL format")
    return parsed_url


def check_url_format(url: str, transport: str | None = None) -> bool:
    """检查端点 URL 是否与 transport 声明匹配。"""
    try:
        parsed_url = _parse_endpoint_url(url)
        allowed_schemes = _TRANSPORT_SCHEME_MAP.get((transport or "").upper())
        if allowed_schemes and parsed_url.scheme not in allowed_schemes:
            raise ValueError(f"Invalid URL scheme '{parsed_url.scheme}' for transport '{transport}'")
        return True
    except ValueError as exc:
        logger.info(f"URL parsing error: {url}, error: {exc}")
        return False


def is_valid_json(json_string: str) -> bool:
    """检查字符串是否为合法 JSON。"""
    try:
        json.loads(json_string)
        return True
    except ValueError as e:
        logger.warning(f"Invalid JSON string: {json_string}, error: {e}")
        return False


def _load_acs_schema() -> JsonObject | None:
    schema_path = Path(__file__).parent.parent / "agent/acsSchema.json"
    if not schema_path.exists():
        return None
    with schema_path.open(encoding="utf-8") as file:
        schema = json.load(file)
    if not isinstance(schema, dict):
        return None
    return {str(key): value for key, value in schema.items()}


def _validate_acs_schema(instance: JsonObject, acs: str | JsonObject) -> None:
    schema = _load_acs_schema()
    if schema is None:
        return

    try:
        json_validate(instance=instance, schema=schema)
    except ValidationError as e:
        logger.error(f"ACS validation error: {e.message}")
        raise AgentError(
            status_code=status.HTTP_400_BAD_REQUEST,
            error_name=AgentErrorCode.INVALID_ACS,
            error_msg=f"Json path: [ {e.json_path} ]; Error message: [ {e.message} ]",
            input_params={"acs": acs},
        ) from None


def _collect_mutual_tls_scheme_names(instance: JsonObject) -> set[str]:
    security_schemes = instance.get("securitySchemes") or {}
    if not isinstance(security_schemes, dict):
        return set()

    mtls_scheme_names: set[str] = set()

    for schema_name, schema in security_schemes.items():
        if not isinstance(schema, dict) or schema.get("type") != "mutualTLS":
            continue

        mtls_scheme_names.add(schema_name)

    return mtls_scheme_names


def _validate_endpoint_security(endpoint: JsonObject, mtls_scheme_names: set[str], acs: str | JsonObject) -> None:
    securities = endpoint.get("security") or []
    for security in securities:
        for security_name in security:
            if security_name in mtls_scheme_names:
                return

    raise AgentError(
        status_code=status.HTTP_400_BAD_REQUEST,
        error_name=AgentErrorCode.INVALID_ACS,
        error_msg="endPoint must use mutualTLS security scheme",
        input_params={"acs": acs},
    )


def _validate_endpoints(instance: JsonObject, mtls_scheme_names: set[str], acs: str | JsonObject) -> None:
    endpoints = instance.get("endPoints")
    if not endpoints:
        return

    for endpoint in endpoints:
        _validate_endpoint_security(endpoint, mtls_scheme_names, acs)

        endpoint_url = endpoint.get("url")
        transport = endpoint.get("transport")
        if not isinstance(endpoint_url, str) or not check_url_format(
            endpoint_url, str(transport) if transport is not None else None
        ):
            raise AgentError(
                status_code=status.HTTP_400_BAD_REQUEST,
                error_name=AgentErrorCode.INVALID_ACS,
                error_msg=f"endpoint URL format: {endpoint.get('url', '')}",
                input_params={"acs": acs},
            )


def validate(acs: str | JsonObject) -> None:
    """校验 ACS 的 JSON 结构与端点安全方案。"""
    if acs is None or (isinstance(acs, str) and not is_valid_json(acs)) or (isinstance(acs, dict) and not acs):
        raise AgentError(
            status_code=status.HTTP_400_BAD_REQUEST,
            error_name=AgentErrorCode.ACS_NOT_EXISTED,
            error_msg="ACS cannot be null",
            input_params={"acs": str(acs)},
        )

    instance = acs if isinstance(acs, dict) else json.loads(acs)
    _validate_acs_schema(instance, acs)
    mtls_scheme_names = _collect_mutual_tls_scheme_names(instance)
    _validate_endpoints(instance, mtls_scheme_names, acs)
