import json
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import ai as ai_module
from app.services import storage as storage_module
from app.tests.test_books import _auth_headers, _token, _upload_pdf

API = "/api/v1"


async def _fake_translation(gemini, part) -> AsyncIterator[str]:
    yield "# Página traduzida\n\n"
    yield "Conteúdo em português."


@pytest.fixture(autouse=True)
def mock_ai_and_storage(monkeypatch):
    monkeypatch.setattr(
        storage_module.storage, "read_bytes", AsyncMock(return_value=b"%PDF-1.4 fake")
    )
    monkeypatch.setattr(ai_module, "stream_translation", _fake_translation)
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
async def test_translate_streams_and_caches(client, monkeypatch):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    resp = await client.post(
        f"{API}/books/{book_id}/translate",
        headers=_auth_headers(token),
        json={"page": 1},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse(resp.text)
    kinds = [e for e, _ in events]
    assert "delta" in kinds
    assert kinds[-1] == "done"
    done = events[-1][1]
    assert done is not None
    assert done["page"] == 1
    assert done["cached"] is False

    # The translation is now cached and fetchable without streaming.
    got = await client.get(
        f"{API}/books/{book_id}/translate/1", headers=_auth_headers(token)
    )
    assert got.status_code == 200
    body = got.json()
    assert body["page"] == 1
    assert body["lang"] == "pt-BR"
    assert "português" in body["markdown"]

    # A second request must hit the cache and never call Gemini again.
    def _boom(gemini, part):
        raise AssertionError("Gemini should not be called on a cache hit")

    monkeypatch.setattr(ai_module, "stream_translation", _boom)
    again = await client.post(
        f"{API}/books/{book_id}/translate",
        headers=_auth_headers(token),
        json={"page": 1},
    )
    assert again.status_code == 200
    again_done = _parse_sse(again.text)[-1][1]
    assert again_done is not None
    assert again_done["cached"] is True


@pytest.mark.asyncio
async def test_translate_force_recalls(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    await client.post(
        f"{API}/books/{book_id}/translate",
        headers=_auth_headers(token),
        json={"page": 1},
    )
    forced = await client.post(
        f"{API}/books/{book_id}/translate",
        headers=_auth_headers(token),
        json={"page": 1, "force": True},
    )
    done = _parse_sse(forced.text)[-1][1]
    assert done is not None
    assert done["cached"] is False


@pytest.mark.asyncio
async def test_translate_requires_api_key(client, monkeypatch):
    monkeypatch.setattr(ai_module.settings, "GEMINI_API_KEY", "")
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    resp = await client.post(
        f"{API}/books/{book_id}/translate",
        headers=_auth_headers(token),
        json={"page": 1},
    )
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_get_cached_404_when_absent(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    resp = await client.get(
        f"{API}/books/{book_id}/translate/1", headers=_auth_headers(token)
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_translate_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = (await _upload_pdf(client, token1)).json()["id"]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        resp = await other.post(
            f"{API}/books/{book_id}/translate",
            headers=_auth_headers(token2),
            json={"page": 1},
        )
        assert resp.status_code == 404
