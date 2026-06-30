import uuid
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.v1.endpoints import word_documents as word_endpoints
from app.main import app
from app.services import storage as storage_module

API = "/api/v1"
PASSWORD = "Passw0rd!"
FAKE_PDF = b"%PDF-1.4\n% fake pdf content\n"
EDITED_DOCX = b"PK\x03\x04 edited docx"


def _email() -> str:
    return f"test-{uuid.uuid4().hex[:12]}@anubis.dev"


async def _register(client, email: str | None = None) -> str:
    addr = email or _email()
    response = await client.post(
        f"{API}/auth/register",
        json={"email": addr, "password": PASSWORD, "full_name": "Test User"},
    )
    assert response.status_code == 201
    return addr


async def _token(client, email: str | None = None) -> tuple[str, str]:
    addr = await _register(client, email)
    login = await client.post(
        f"{API}/auth/login",
        json={"email": addr, "password": PASSWORD},
    )
    assert login.status_code == 200
    return addr, login.json()["access_token"]


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def mock_storage(monkeypatch):
    store: dict[str, bytes] = {}

    async def upload(key: str, body: bytes, content_type: str) -> None:
        store[key] = body

    async def delete(key: str) -> None:
        store.pop(key, None)

    async def stream(key: str):
        yield store[key]

    monkeypatch.setattr(storage_module.storage, "upload", AsyncMock(side_effect=upload))
    monkeypatch.setattr(storage_module.storage, "delete", AsyncMock(side_effect=delete))
    monkeypatch.setattr(storage_module.storage, "stream", stream)
    monkeypatch.setattr(storage_module.storage, "_test_store", store, raising=False)
    return store


async def _make_book(client, token: str, title: str = "Test Book") -> int:
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": title, "author": "Test Author"},
        files={"file": ("book.pdf", FAKE_PDF, "application/pdf")},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_word(client, token: str, book_id: int, **overrides):
    payload = {"title": "Resumo", "page": 3}
    payload.update(overrides)
    return await client.post(
        f"{API}/books/{book_id}/word-documents",
        headers=_auth_headers(token),
        json=payload,
    )


@pytest.mark.asyncio
async def test_create_list_update_and_download_word_document(client, mock_storage):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    created = await _create_word(client, token, book_id)
    assert created.status_code == 201
    body = created.json()
    assert body["title"] == "Resumo"
    assert body["page"] == 3
    assert body["revision"] == 1
    assert body["file_size"] > 0
    assert any(data.startswith(b"PK") for data in mock_storage.values())

    listing = await client.get(
        f"{API}/books/{book_id}/word-documents", headers=_auth_headers(token)
    )
    assert listing.status_code == 200
    assert [doc["id"] for doc in listing.json()] == [body["id"]]

    patched = await client.patch(
        f"{API}/books/{book_id}/word-documents/{body['id']}",
        headers=_auth_headers(token),
        json={"title": "Resumo final", "page": None},
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "Resumo final"
    assert patched.json()["page"] is None

    download = await client.get(
        f"{API}/books/{book_id}/word-documents/{body['id']}/download",
        headers=_auth_headers(token),
    )
    assert download.status_code == 200
    assert download.content.startswith(b"PK")
    assert "Resumo final.docx" in download.headers["content-disposition"]


@pytest.mark.asyncio
async def test_word_documents_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = await _make_book(client, token1)
    document = (await _create_word(client, token1, book_id)).json()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)

        assert (
            await other.get(
                f"{API}/books/{book_id}/word-documents",
                headers=_auth_headers(token2),
            )
        ).status_code == 404
        assert (
            await other.patch(
                f"{API}/books/{book_id}/word-documents/{document['id']}",
                headers=_auth_headers(token2),
                json={"title": "Hijack"},
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_onlyoffice_config_contains_signed_docx_urls(client, monkeypatch):
    monkeypatch.setattr(word_endpoints.settings, "ONLYOFFICE_ENABLED", True)
    monkeypatch.setattr(
        word_endpoints.settings,
        "ONLYOFFICE_DOCSERVER_PUBLIC_URL",
        "http://documentserver",
    )
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    document = (await _create_word(client, token, book_id)).json()

    response = await client.post(
        f"{API}/books/{book_id}/word-documents/{document['id']}/onlyoffice-config",
        headers=_auth_headers(token),
        json={},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["document_server_url"] == "http://documentserver"
    config = body["config"]
    assert config["documentType"] == "word"
    assert config["document"]["fileType"] == "docx"
    assert config["document"]["key"] == f"word-{document['id']}-1"
    assert config["editorConfig"]["lang"] == "pt"
    assert config["editorConfig"]["region"] == "pt-BR"
    assert config["editorConfig"]["customization"]["forcesave"] is True
    assert config["editorConfig"]["customization"]["unit"] == "cm"
    assert "/onlyoffice/word-documents/" in config["document"]["url"]
    assert "/callback" in config["editorConfig"]["callbackUrl"]
    assert config["token"]


@pytest.mark.asyncio
@pytest.mark.parametrize("callback_status", [2, 6])
async def test_onlyoffice_callback_saves_docx_and_increments_revision(
    client, monkeypatch, mock_storage, callback_status
):
    async def edited_docx(url: str) -> bytes:
        assert url == "http://documentserver/edited.docx"
        return EDITED_DOCX

    monkeypatch.setattr(word_endpoints, "_download_edited_docx", edited_docx)
    monkeypatch.setattr(word_endpoints.settings, "ONLYOFFICE_ENABLED", True)
    monkeypatch.setattr(
        word_endpoints.settings,
        "ONLYOFFICE_DOCSERVER_PUBLIC_URL",
        "http://documentserver",
    )
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    document = (await _create_word(client, token, book_id)).json()
    config_response = await client.post(
        f"{API}/books/{book_id}/word-documents/{document['id']}/onlyoffice-config",
        headers=_auth_headers(token),
        json={},
    )
    callback_url = config_response.json()["config"]["editorConfig"]["callbackUrl"]
    parsed = urlparse(callback_url)
    callback_path = parsed.path
    callback_token = parse_qs(parsed.query)["token"][0]

    callback = await client.post(
        f"{callback_path}?token={callback_token}",
        json={
            "key": f"word-{document['id']}-1",
            "status": callback_status,
            "url": "http://documentserver/edited.docx",
            "filetype": "docx",
        },
    )

    assert callback.status_code == 200
    assert callback.json() == {"error": 0}
    fetched = await client.get(
        f"{API}/books/{book_id}/word-documents/{document['id']}",
        headers=_auth_headers(token),
    )
    assert fetched.json()["revision"] == 2
    assert fetched.json()["file_size"] == len(EDITED_DOCX)
    assert EDITED_DOCX in mock_storage.values()


@pytest.mark.asyncio
async def test_reader_state_accepts_word_panel(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    document = (await _create_word(client, token, book_id)).json()

    response = await client.put(
        f"{API}/books/{book_id}/reader-state",
        headers=_auth_headers(token),
        json={
            "version": 1,
            "zoom_pct": 120,
            "panel": "word",
            "panel_width_px": 640,
            "notes": {"view": "list", "active_id": None, "search": ""},
            "diagrams": {"view": "list", "active_id": None},
            "sketches": {
                "view": "list",
                "active_id": None,
                "active_group_id": None,
                "search": "",
            },
            "latex": {
                "view": "list",
                "active_id": None,
                "active_group_id": None,
                "search": "",
            },
            "word": {
                "view": "edit",
                "active_id": document["id"],
                "search": "resumo",
            },
        },
    )

    assert response.status_code == 200
    state = response.json()["reader_state"]
    assert state["panel"] == "word"
    assert state["word"]["active_id"] == document["id"]
    assert state["word"]["search"] == "resumo"
