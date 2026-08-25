from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.discovery.semantic_matcher import SemanticAgentMatcher


semantic_matcher: SemanticAgentMatcher | None = None


def set_matcher(matcher: SemanticAgentMatcher | None) -> None:
    global semantic_matcher
    semantic_matcher = matcher


def get_matcher() -> SemanticAgentMatcher | None:
    return semantic_matcher
