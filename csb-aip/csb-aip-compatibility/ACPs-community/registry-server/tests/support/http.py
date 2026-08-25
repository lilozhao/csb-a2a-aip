"""测试用 HTTP JSON 响应辅助函数。"""

from __future__ import annotations

from typing import cast

from httpx import Response

type JsonObject = dict[str, object]
type JsonStringMap = dict[str, str]


def response_json_object(response: Response) -> JsonObject:
    """返回按对象映射收口的 JSON 响应体。"""

    return cast("JsonObject", response.json())


def response_json_string_map(response: Response) -> JsonStringMap:
    """返回按字符串映射收口的 JSON 响应体。"""

    return cast("JsonStringMap", response.json())


def response_json_string_field(response: Response, field: str) -> str:
    """返回 JSON 响应体中的指定字符串字段。"""

    value = response_json_object(response)[field]
    assert isinstance(value, str)
    return value
