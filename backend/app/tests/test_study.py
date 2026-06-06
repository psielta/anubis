import json
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import ai as ai_module
from app.services import storage as storage_module
from app.tests.test_books import _auth_headers, _token, _upload_pdf

API = "/api/v1"


async def _fake_stream(gemini, part, kind, question, selection=None):
    yield ("thinking", "Looking through the document…")
    yield ("answer", "# Answer\n\nGrounded in the PDF.")


@pytest.fixture(autouse=True)
def mock_ai_and_storage(monkeypatch):
    monkeypatch.setattr(storage_module.storage, "upload", AsyncMock())
    monkeypatch.setattr(storage_module.storage, "delete", AsyncMock())
    monkeypatch.setattr(
        storage_module.storage, "read_bytes", AsyncMock(return_value=b"%PDF-1.4 fake")
    )
    monkeypatch.setattr(ai_module, "stream_reply", _fake_stream)
    monkeypatch.setattr(ai_module, "client", lambda: object())
    monkeypatch.setattr(
        ai_module, "extract_pages", AsyncMock(return_value=b"%PDF-1.4 fake")
    )
    monkeypatch.setattr(ai_module.settings, "GEMINI_API_KEY", "test-key")


def _parse_sse(text: str) -> list[tuple[str, dict | None]]:
    events: list[tuple[str, dict | None]] = []
    for frame in text.strip().split("\n\n"):
        event, data = None, None
        for line in frame.splitlines():
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data = json.loads(line[len("data:") :].strip())
        if event:
            events.append((event, data))
    return events


@pytest.mark.asyncio
async def test_ask_streams_and_persists(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    resp = await client.post(
        f"{API}/books/{book_id}/study",
        headers=_auth_headers(token),
        json={"kind": "chat", "question": "What is this about?", "scope": "book"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse(resp.text)
    kinds = [e for e, _ in events]
    assert "thinking" in kinds
    assert "delta" in kinds
    assert kinds[-1] == "done"

    history = (
        await client.get(f"{API}/books/{book_id}/study", headers=_auth_headers(token))
    ).json()
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert history[1]["content"].startswith("# Answer")
    assert history[1]["kind"] == "chat"


@pytest.mark.asyncio
async def test_ask_about_selection_quotes_passage(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    resp = await client.post(
        f"{API}/books/{book_id}/study",
        headers=_auth_headers(token),
        json={
            "kind": "chat",
            "question": "What does this mean?",
            "scope": "chapter",
            "page_from": 1,
            "page_to": 2,
            "selection": "The weighing of the heart against the feather of Maat.",
        },
    )
    assert resp.status_code == 200

    history = (
        await client.get(f"{API}/books/{book_id}/study", headers=_auth_headers(token))
    ).json()
    user_msg = history[0]
    assert user_msg["role"] == "user"
    assert user_msg["scope"] == "Selection"
    assert "weighing of the heart" in user_msg["content"].lower()
    assert "What does this mean?" in user_msg["content"]


@pytest.mark.asyncio
async def test_summary_persists_assistant_only(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    resp = await client.post(
        f"{API}/books/{book_id}/study",
        headers=_auth_headers(token),
        json={"kind": "summary", "scope": "book"},
    )
    assert resp.status_code == 200

    history = (
        await client.get(f"{API}/books/{book_id}/study", headers=_auth_headers(token))
    ).json()
    assert [m["role"] for m in history] == ["assistant"]
    assert history[0]["kind"] == "summary"


@pytest.mark.asyncio
async def test_clear_history(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    await client.post(
        f"{API}/books/{book_id}/study",
        headers=_auth_headers(token),
        json={"kind": "summary", "scope": "book"},
    )

    resp = await client.delete(
        f"{API}/books/{book_id}/study", headers=_auth_headers(token)
    )
    assert resp.status_code == 204
    history = (
        await client.get(f"{API}/books/{book_id}/study", headers=_auth_headers(token))
    ).json()
    assert history == []


@pytest.mark.asyncio
async def test_study_requires_api_key(client, monkeypatch):
    monkeypatch.setattr(ai_module.settings, "GEMINI_API_KEY", "")
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    resp = await client.post(
        f"{API}/books/{book_id}/study",
        headers=_auth_headers(token),
        json={"kind": "summary", "scope": "book"},
    )
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_study_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = (await _upload_pdf(client, token1)).json()["id"]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        resp = await other.get(
            f"{API}/books/{book_id}/study", headers=_auth_headers(token2)
        )
        assert resp.status_code == 404
