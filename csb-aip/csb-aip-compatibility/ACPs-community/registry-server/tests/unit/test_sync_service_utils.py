"""针对 sync/service.py 纯函数的单元测试。

覆盖：generate_snapshot_id、calculate_expire_time、create_changelog_response、
Envelope/retention 纯 helper、generate_webhook_id、generate_webhook_signature、
_mark_inflight/_clear_inflight。这些函数均无需数据库连接，可直接单元测试。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

import app.sync.service as svc

pytestmark = pytest.mark.unit


class TestGenerateSnapshotId:
    def test_starts_with_snap_prefix(self) -> None:
        sid = svc.generate_snapshot_id()
        assert sid.startswith("snap_")

    def test_generates_unique_ids(self) -> None:
        ids = {svc.generate_snapshot_id() for _ in range(50)}
        assert len(ids) == 50

    def test_format_length(self) -> None:
        sid = svc.generate_snapshot_id()
        # "snap_" (5) + 12 hex chars
        assert len(sid) == 17


class TestGenerateWebhookId:
    def test_starts_with_wh_prefix(self) -> None:
        wid = svc.generate_webhook_id()
        assert wid.startswith("wh_")

    def test_generates_unique_ids(self) -> None:
        ids = {svc.generate_webhook_id() for _ in range(50)}
        assert len(ids) == 50

    def test_format_length(self) -> None:
        wid = svc.generate_webhook_id()
        assert len(wid) == 15  # "wh_" (3) + 12 hex chars


class TestCalculateExpireTime:
    def test_returns_future_datetime(self) -> None:
        expire = svc.calculate_expire_time(access_timeout_hours=1, max_lifetime_hours=24)
        from app.utils.utils import get_beijing_time

        assert expire > get_beijing_time()

    def test_smaller_timeout_wins(self) -> None:
        expire_short = svc.calculate_expire_time(access_timeout_hours=1, max_lifetime_hours=100)
        expire_long = svc.calculate_expire_time(access_timeout_hours=48, max_lifetime_hours=100)
        # 1h < 48h，短超时应先到期
        assert expire_short < expire_long

    def test_max_lifetime_respected(self) -> None:
        expire = svc.calculate_expire_time(access_timeout_hours=1000, max_lifetime_hours=1)
        from datetime import timedelta

        from app.utils.utils import get_beijing_time

        # 由于 max_lifetime = 1h，所以应在约 1 小时内过期
        assert expire < get_beijing_time() + timedelta(hours=2)

    def test_defaults_used_when_none_passed(self) -> None:
        # 不传参数，使用 settings 中的默认值
        expire = svc.calculate_expire_time()
        from app.utils.utils import get_beijing_time

        assert expire > get_beijing_time()


class TestCreateChangelogResponse:
    def test_converts_changelog_to_response(self) -> None:
        from app.sync.model import ChangeLog
        from app.utils.utils import get_beijing_time

        log = ChangeLog()
        log.seq = 1
        log.ts = get_beijing_time()
        log.type = "agent"
        log.op = "upsert"
        log.id = str(uuid.uuid4())
        log.version = 1
        log.payload = None

        response = svc.create_changelog_response(log)
        assert response.seq == 1
        assert response.type == "agent"


class TestEnvelopeHelpers:
    def test_build_envelope_parses_string_payload(self) -> None:
        item = SimpleNamespace(
            seq=7,
            ts=None,
            op="upsert",
            type="acs",
            id="aic-1",
            version=3,
            payload='{"foo": "bar"}',
        )

        envelope = svc._build_envelope(item)

        assert envelope is not None
        assert envelope.seq == 7
        assert envelope.payload == {"foo": "bar"}

    def test_build_envelope_returns_none_for_invalid_json(self) -> None:
        item = SimpleNamespace(
            seq=7,
            ts=None,
            op="upsert",
            type="acs",
            id="aic-1",
            version=3,
            payload="{invalid-json}",
        )

        assert svc._build_envelope(item) is None

    def test_build_changes_result_skips_invalid_payload_and_tracks_last_seq(self) -> None:
        valid_first = SimpleNamespace(
            seq=11,
            ts=None,
            op="upsert",
            type="acs",
            id="aic-1",
            version=1,
            payload={"foo": "bar"},
        )
        invalid = SimpleNamespace(
            seq=12,
            ts=None,
            op="upsert",
            type="acs",
            id="aic-2",
            version=1,
            payload="{invalid-json}",
        )
        valid_last = SimpleNamespace(
            seq=13,
            ts=None,
            op="delete",
            type="acs",
            id="aic-3",
            version=2,
            payload=None,
        )

        envelopes, next_seq = svc._build_changes_result([valid_first, invalid, valid_last], initial_seq=10)

        assert [envelope.seq for envelope in envelopes] == [11, 13]
        assert next_seq == 13


class TestResolveRetentionOldestSeq:
    @pytest.mark.parametrize(
        ("time_based_seq", "record_based_seq", "min_seq", "expected"),
        [
            (100, 120, None, 120),
            (100, None, None, 100),
            (None, 120, None, 120),
            (None, None, 5, 5),
            (None, None, None, 1),
        ],
    )
    def test_resolves_oldest_seq(
        self, time_based_seq: int | None, record_based_seq: int | None, min_seq: int | None, expected: int
    ) -> None:
        assert svc._resolve_retention_oldest_seq(time_based_seq, record_based_seq, min_seq) == expected


class TestGenerateWebhookSignature:
    def test_returns_sha256_prefixed_string(self) -> None:
        sig = svc.generate_webhook_signature("my-secret", 1234567890, '{"event":"test"}')
        assert sig.startswith("sha256=")

    def test_deterministic(self) -> None:
        sig1 = svc.generate_webhook_signature("secret", 100, "payload")
        sig2 = svc.generate_webhook_signature("secret", 100, "payload")
        assert sig1 == sig2

    def test_different_secrets_produce_different_sigs(self) -> None:
        sig1 = svc.generate_webhook_signature("secret-a", 100, "payload")
        sig2 = svc.generate_webhook_signature("secret-b", 100, "payload")
        assert sig1 != sig2

    def test_different_timestamps_produce_different_sigs(self) -> None:
        sig1 = svc.generate_webhook_signature("secret", 100, "payload")
        sig2 = svc.generate_webhook_signature("secret", 200, "payload")
        assert sig1 != sig2

    def test_different_payloads_produce_different_sigs(self) -> None:
        sig1 = svc.generate_webhook_signature("secret", 100, "payload-a")
        sig2 = svc.generate_webhook_signature("secret", 100, "payload-b")
        assert sig1 != sig2


class TestInflightMarkAndClear:
    def setup_method(self) -> None:
        # 清理 inflight 集合，防止测试间干扰
        with svc._inflight_sends_lock:
            svc._inflight_sends.clear()

    def test_mark_returns_true_when_not_inflight(self) -> None:
        assert svc._mark_inflight("wh_001", "data.change") is True

    def test_mark_returns_false_when_already_inflight(self) -> None:
        svc._mark_inflight("wh_002", "data.change")
        assert svc._mark_inflight("wh_002", "data.change") is False

    def test_different_event_can_be_marked(self) -> None:
        svc._mark_inflight("wh_003", "event.a")
        assert svc._mark_inflight("wh_003", "event.b") is True

    def test_clear_allows_remarking(self) -> None:
        svc._mark_inflight("wh_004", "data.change")
        svc._clear_inflight("wh_004", "data.change")
        assert svc._mark_inflight("wh_004", "data.change") is True

    def test_clear_nonexistent_no_error(self) -> None:
        svc._clear_inflight("wh_999", "missing.event")
