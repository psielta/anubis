import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import storage as storage_module
from app.services.storage import StorageService

API = "/api/v1"
PASSWORD = "Passw0rd!"
FAKE_PDF = b"%PDF-1.4\n% fake pdf content\n"
FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24


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


async def _mock_stream(key: str):
    yield b"chunk1"
    yield b"chunk2"


class _FakeStreamingBody:
    def __init__(self) -> None:
        self.closed = False
        self.entered = False

    async def __aenter__(self):
        self.entered = True
        return object()

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        return None

    async def iter_chunks(self, chunk_size: int):
        assert chunk_size == 64 * 1024
        yield b"chunk1"
        yield b"chunk2"

    def close(self) -> None:
        self.closed = True


class _FakeS3Client:
    def __init__(self, body: _FakeStreamingBody) -> None:
        self.body = body
        self.kwargs = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        return None

    async def get_object(self, **kwargs):
        self.kwargs = kwargs
        return {"Body": self.body}


@pytest.fixture(autouse=True)
def mock_storage(monkeypatch):
    monkeypatch.setattr(storage_module.storage, "upload", AsyncMock())
    monkeypatch.setattr(storage_module.storage, "delete", AsyncMock())
    monkeypatch.setattr(
        storage_module.storage, "stream", MagicMock(side_effect=_mock_stream)
    )


async def _upload_pdf(client, token: str, title: str = "Test Book") -> dict:
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": title, "author": "Test Author"},
        files={"file": ("book.pdf", FAKE_PDF, "application/pdf")},
    )
    return response


@pytest.mark.asyncio
async def test_storage_stream_reads_wrapper_iter_chunks_and_closes_body(monkeypatch):
    service = StorageService()
    body = _FakeStreamingBody()
    client = _FakeS3Client(body)
    monkeypatch.setattr(service, "_client", lambda: client)

    chunks = [chunk async for chunk in service.stream("books/test.pdf")]

    assert chunks == [b"chunk1", b"chunk2"]
    assert client.kwargs is not None
    assert client.kwargs["Key"] == "books/test.pdf"
    assert body.closed
    assert not body.entered


@pytest.mark.asyncio
async def test_import_book_without_token_returns_401(client):
    response = await client.post(
        f"{API}/books",
        data={"title": "No Auth"},
        files={"file": ("book.pdf", FAKE_PDF, "application/pdf")},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_import_valid_pdf_returns_201(client):
    _, token = await _token(client)
    response = await _upload_pdf(client, token)
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Test Book"
    assert body["author"] == "Test Author"
    assert body["file_format"] == "pdf"
    assert body["content_type"] == "application/pdf"
    assert body["file_size"] == len(FAKE_PDF)
    assert body["original_filename"] == "book.pdf"
    assert "object_key" not in body
    storage_module.storage.upload.assert_awaited_once()


@pytest.mark.asyncio
async def test_import_epub_now_rejected(client):
    _, token = await _token(client)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": "EPUB Book"},
        files={"file": ("book.epub", b"PK\x03\x04 epub", "application/epub+zip")},
    )
    assert response.status_code == 415


@pytest.mark.asyncio
async def test_import_txt_returns_415(client):
    _, token = await _token(client)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": "Text"},
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 415


@pytest.mark.asyncio
async def test_import_oversized_returns_413(client, monkeypatch):
    monkeypatch.setattr("app.api.v1.endpoints.books.settings.MAX_UPLOAD_SIZE_MB", 0)
    _, token = await _token(client)
    response = await _upload_pdf(client, token)
    assert response.status_code == 413


@pytest.mark.asyncio
async def test_list_books_isolated_per_user(client):
    _, token1 = await _token(client)
    await _upload_pdf(client, token1, "User One Book")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other_client:
        _, token2 = await _token(other_client)

        list1 = await client.get(f"{API}/books", headers=_auth_headers(token1))
        list2 = await other_client.get(f"{API}/books", headers=_auth_headers(token2))
        assert list1.status_code == 200
        assert list2.status_code == 200
        assert len(list1.json()) == 1
        assert len(list2.json()) == 0
        book_id = list1.json()[0]["id"]

        other_file = await other_client.get(
            f"{API}/books/{book_id}/file",
            headers=_auth_headers(token2),
        )
        assert other_file.status_code == 404


@pytest.mark.asyncio
async def test_delete_book_returns_204_and_deletes_storage(client):
    _, token = await _token(client)
    created = await _upload_pdf(client, token)
    book_id = created.json()["id"]

    response = await client.delete(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
    )
    assert response.status_code == 204
    storage_module.storage.delete.assert_awaited()

    listing = await client.get(f"{API}/books", headers=_auth_headers(token))
    assert listing.json() == []


@pytest.mark.asyncio
async def test_import_without_cover_reports_no_cover(client):
    _, token = await _token(client)
    response = await _upload_pdf(client, token)
    assert response.status_code == 201
    assert response.json()["has_cover"] is False
    storage_module.storage.upload.assert_awaited_once()


@pytest.mark.asyncio
async def test_import_with_manual_cover_sets_cover(client):
    _, token = await _token(client)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": "With Cover"},
        files={
            "file": ("book.pdf", FAKE_PDF, "application/pdf"),
            "cover": ("cover.png", FAKE_PNG, "image/png"),
        },
    )
    assert response.status_code == 201
    assert response.json()["has_cover"] is True
    # book file + cover image
    assert storage_module.storage.upload.await_count == 2


@pytest.mark.asyncio
async def test_set_and_get_cover(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    set_resp = await client.post(
        f"{API}/books/{book_id}/cover",
        headers=_auth_headers(token),
        files={"cover": ("cover.png", FAKE_PNG, "image/png")},
    )
    assert set_resp.status_code == 200
    assert set_resp.json()["has_cover"] is True

    get_resp = await client.get(
        f"{API}/books/{book_id}/cover", headers=_auth_headers(token)
    )
    assert get_resp.status_code == 200
    assert get_resp.headers["content-type"].startswith("image/png")


@pytest.mark.asyncio
async def test_set_cover_rejects_non_image(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.post(
        f"{API}/books/{book_id}/cover",
        headers=_auth_headers(token),
        files={"cover": ("note.txt", b"not an image", "text/plain")},
    )
    assert response.status_code == 415
    assert (await client.get(f"{API}/books/{book_id}", headers=_auth_headers(token))).json()[
        "has_cover"
    ] is False


@pytest.mark.asyncio
async def test_get_cover_404_when_absent(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    response = await client.get(
        f"{API}/books/{book_id}/cover", headers=_auth_headers(token)
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_cover_clears_it(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    await client.post(
        f"{API}/books/{book_id}/cover",
        headers=_auth_headers(token),
        files={"cover": ("cover.png", FAKE_PNG, "image/png")},
    )

    delete_resp = await client.delete(
        f"{API}/books/{book_id}/cover", headers=_auth_headers(token)
    )
    assert delete_resp.status_code == 204
    storage_module.storage.delete.assert_awaited()

    book = await client.get(f"{API}/books/{book_id}", headers=_auth_headers(token))
    assert book.json()["has_cover"] is False


@pytest.mark.asyncio
async def test_cover_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = (await _upload_pdf(client, token1)).json()["id"]
    await client.post(
        f"{API}/books/{book_id}/cover",
        headers=_auth_headers(token1),
        files={"cover": ("cover.png", FAKE_PNG, "image/png")},
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        resp = await other.get(
            f"{API}/books/{book_id}/cover", headers=_auth_headers(token2)
        )
        assert resp.status_code == 404
