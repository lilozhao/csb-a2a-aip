"""真实数据库集成测试：changes 与 info 主路径。"""

import json

import pytest
from sqlalchemy import select

from app.sync.model import ChangeLog

pytestmark = pytest.mark.integration


async def test_info_reflects_current_change_log_window(client, db_session) -> None:
    db_session.add(
        ChangeLog(
            seq=1,
            type="acs",
            op="upsert",
            id="agent-1",
            version=1,
            payload={"aic": "agent-1", "active": True},
        )
    )
    await db_session.commit()

    response = await client.get("/acps-dsp-v2/info")

    assert response.status_code == 200
    payload = response.json()
    assert payload["service"]
    assert payload["retention"]["newest_seq"] == 1
    assert payload["retention"]["oldest_seq"] == 1
    assert payload["supported_types"] == ["acs"]


async def test_changes_returns_real_ndjson_records_from_database(client, db_session) -> None:
    db_session.add_all(
        [
            ChangeLog(
                seq=1,
                type="acs",
                op="upsert",
                id="agent-1",
                version=1,
                payload={"aic": "agent-1", "active": True},
            ),
            ChangeLog(
                seq=2,
                type="acs",
                op="upsert",
                id="agent-2",
                version=2,
                payload={"aic": "agent-2", "active": True},
            ),
            ChangeLog(
                seq=3,
                type="acs",
                op="delete",
                id="agent-3",
                version=3,
                payload={"aic": "agent-3", "active": False},
            ),
        ]
    )
    await db_session.commit()

    response = await client.get("/acps-dsp-v2/changes", params={"seq": 1, "limit": 2, "types": "acs"})

    assert response.status_code == 200
    assert response.headers["X-Next-Seq"] == "3"
    assert response.headers["content-type"].startswith("application/x-ndjson")

    lines = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    assert [line["seq"] for line in lines] == [2, 3]
    assert lines[0]["payload"]["aic"] == "agent-2"
    assert lines[1]["op"] == "delete"

    result = await db_session.execute(select(ChangeLog))
    assert len(list(result.scalars().all())) == 3
