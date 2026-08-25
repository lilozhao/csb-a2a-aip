from __future__ import annotations

from typing import Any, Literal, cast

import pytest

import app.agent.smtp as smtp_mod
from app.account.model import User
from app.agent.model import EmailCode

pytestmark = pytest.mark.unit


class DummySyncScalarsResult:
    def __init__(self, items: list[object]) -> None:
        self._items = items

    def all(self) -> list[object]:
        return self._items


class DummySyncExecuteResult:
    def __init__(self, items: list[object]) -> None:
        self._items = items

    def scalars(self) -> DummySyncScalarsResult:
        return DummySyncScalarsResult(self._items)


class DummySyncSession:
    def __init__(self, *, items: list[object] | None = None) -> None:
        self._items = items or []
        self.added: list[object] = []
        self.committed = False
        self.refreshed: list[object] = []

    def execute(self, statement: object) -> DummySyncExecuteResult:
        del statement
        return DummySyncExecuteResult(self._items)

    def add(self, item: object) -> None:
        self.added.append(item)

    def commit(self) -> None:
        self.committed = True

    def refresh(self, item: object) -> None:
        self.refreshed.append(item)


class DummySyncSessionContext:
    def __init__(self, session: DummySyncSession) -> None:
        self._session = session

    def __enter__(self) -> DummySyncSession:
        return self._session

    def __exit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
        del exc_type, exc, tb
        return False


async def test_send_need_review_mail_sends_review_link_to_staff_users(monkeypatch: pytest.MonkeyPatch) -> None:
    session = DummySyncSession(
        items=[
            User(username="staff-user", email="staff@example.com"),
            User(username="staff-no-email", email=None),
        ]
    )
    sent_messages: list[tuple[str, str, str]] = []

    monkeypatch.setattr(smtp_mod, "have_config", lambda: True)
    monkeypatch.setattr(smtp_mod, "get_sync_session", lambda: DummySyncSessionContext(session))
    monkeypatch.setattr(
        smtp_mod,
        "send_mail",
        lambda to_email, subject, html_content: sent_messages.append((to_email, subject, html_content)),
    )

    await smtp_mod.send_need_review_mail("agt-123", "Demo Agent", "https://portal.example.com")

    assert len(sent_messages) == 1
    to_email, subject, html_content = sent_messages[0]
    assert to_email == "staff@example.com"
    assert "Demo Agent" in subject
    assert "agentId=agt-123" in html_content


def test_send_code_persists_email_code_and_sends_email(monkeypatch: pytest.MonkeyPatch) -> None:
    session = DummySyncSession()
    sent_messages: list[tuple[str, str, str]] = []

    monkeypatch.setattr(smtp_mod, "have_config", lambda: True)
    monkeypatch.setattr(smtp_mod, "get_sync_session", lambda: DummySyncSessionContext(session))
    monkeypatch.setattr("app.agent.smtp.secrets.choice", lambda charset: "Z")
    monkeypatch.setattr(
        smtp_mod,
        "send_mail",
        lambda to_email, subject, html_content: sent_messages.append((to_email, subject, html_content)),
    )

    result = smtp_mod.send_code("user@example.com")

    assert result is True
    assert session.committed is True
    assert len(session.added) == 1
    email_code = cast("Any", session.added[0])
    assert isinstance(email_code, EmailCode)
    assert email_code.email == "user@example.com"
    assert email_code.code == "ZZZZ"
    assert session.refreshed == [email_code]
    assert sent_messages == [("user@example.com", "【验证码通知】", sent_messages[0][2])]
    assert "ZZZZ" in sent_messages[0][2]
    assert "5分钟" in sent_messages[0][2]
