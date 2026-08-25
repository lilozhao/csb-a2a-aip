"""Validation helpers for AICs, group IDs, and peer certificates."""

from __future__ import annotations

import re
from typing import Any

_RE_DIGITS = re.compile(r"^[0-9]+$")
_RE_BASE36 = re.compile(r"^[0-9A-Z]+$")
_RE_GROUP_ID = re.compile(r"^[a-zA-Z0-9-]+$")
_AIC_PREFIX = ("1", "2", "156", "3088")
_SEGMENT_CONSTRAINTS = {
    5: (1, 1),
    6: (1, 6),
    7: (1, 6),
    8: (1, 9),
    9: (1, 9),
    10: (4, 4),
}


def validate_aic_format(aic: str, *, expected_prefix: tuple[str, ...] = _AIC_PREFIX) -> bool:
    """Validate AIC format without checking the checksum."""

    if not aic:
        return False
    parts = aic.split(".")
    if len(parts) != 10:
        return False
    if expected_prefix and tuple(parts[: len(expected_prefix)]) != expected_prefix:
        return False
    if not all(_RE_DIGITS.fullmatch(parts[index]) for index in range(4)):
        return False
    for level in range(5, 11):
        segment = parts[level - 1]
        min_len, max_len = _SEGMENT_CONSTRAINTS[level]
        if not _RE_BASE36.fullmatch(segment):
            return False
        if not (min_len <= len(segment) <= max_len):
            return False
    return True


def validate_group_id_format(group_id: str) -> bool:
    """Validate the constrained group-id format defined by the spec."""

    if not group_id:
        return False
    if not _RE_GROUP_ID.fullmatch(group_id):
        return False
    return len(group_id.encode("utf-8")) <= 128


def extract_common_name(peer_certificate: dict[str, Any] | None) -> str | None:
    """Extract the peer certificate common name from ssl.getpeercert() output."""

    if peer_certificate is None:
        return None
    subject = peer_certificate.get("subject")
    if not isinstance(subject, tuple):
        return None
    for rdns in subject:
        if not isinstance(rdns, tuple):
            continue
        for attribute in rdns:
            if (
                isinstance(attribute, tuple)
                and len(attribute) == 2
                and attribute[0] == "commonName"
                and isinstance(attribute[1], str)
            ):
                return attribute[1]
    return None
