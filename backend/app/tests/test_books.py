import uuid
from unittest.mock import AsyncMock, MagicMock

import pymupdf
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import storage as storage_module
from app.services.metadata import extract_pdf_metadata
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


def _pdf_with_metadata(
    title: str | None = None, author: str | None = None, pages: int = 1
) -> bytes:
    """Build a real, parseable PDF carrying the given embedded metadata."""
    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page()
    meta: dict[str, str] = {}
    if title is not None:
        meta["title"] = title
    if author is not None:
        meta["author"] = author
    if meta:
        doc.set_metadata(meta)
    data: bytes = doc.tobytes()
    doc.close()
    return data


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
        assert list1.json()["total"] == 1
        assert list2.json()["total"] == 0
        book_id = list1.json()["items"][0]["id"]

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
    assert listing.json()["items"] == []
    assert listing.json()["total"] == 0


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


@pytest.mark.asyncio
async def test_update_progress_sets_values(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.put(
        f"{API}/books/{book_id}/progress",
        headers=_auth_headers(token),
        json={"last_page": 3, "page_count": 10},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["last_page"] == 3
    assert body["page_count"] == 10


@pytest.mark.asyncio
async def test_progress_clamped_to_page_count(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.put(
        f"{API}/books/{book_id}/progress",
        headers=_auth_headers(token),
        json={"last_page": 99, "page_count": 10},
    )
    assert response.status_code == 200
    assert response.json()["last_page"] == 10


@pytest.mark.asyncio
async def test_progress_rejects_invalid_page(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.put(
        f"{API}/books/{book_id}/progress",
        headers=_auth_headers(token),
        json={"last_page": 0, "page_count": 10},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_progress_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = (await _upload_pdf(client, token1)).json()["id"]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        resp = await other.put(
            f"{API}/books/{book_id}/progress",
            headers=_auth_headers(token2),
            json={"last_page": 2, "page_count": 10},
        )
        assert resp.status_code == 404


async def _create_collection(client, token: str, name: str) -> int:
    resp = await client.post(
        f"{API}/collections", headers=_auth_headers(token), json={"name": name}
    )
    assert resp.status_code == 201
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_create_and_list_collections(client):
    _, token = await _token(client)
    await _create_collection(client, token, "Ancient Egypt")
    await _create_collection(client, token, "Studying")

    resp = await client.get(f"{API}/collections", headers=_auth_headers(token))
    assert resp.status_code == 200
    names = [c["name"] for c in resp.json()]
    assert names == ["Ancient Egypt", "Studying"]  # ordered by name


@pytest.mark.asyncio
async def test_duplicate_collection_returns_409(client):
    _, token = await _token(client)
    await _create_collection(client, token, "Egypt")
    resp = await client.post(
        f"{API}/collections", headers=_auth_headers(token), json={"name": "Egypt"}
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_assign_book_to_collections(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    coll_id = await _create_collection(client, token, "Egypt")

    resp = await client.put(
        f"{API}/books/{book_id}/collections",
        headers=_auth_headers(token),
        json={"collection_ids": [coll_id]},
    )
    assert resp.status_code == 200
    assert resp.json()["collection_ids"] == [coll_id]

    listing = await client.get(f"{API}/collections", headers=_auth_headers(token))
    assert listing.json()[0]["book_count"] == 1


@pytest.mark.asyncio
async def test_filter_books_by_collection(client):
    _, token = await _token(client)
    a = (await _upload_pdf(client, token, "Alpha")).json()["id"]
    await _upload_pdf(client, token, "Beta")
    coll_id = await _create_collection(client, token, "Egypt")
    await client.put(
        f"{API}/books/{a}/collections",
        headers=_auth_headers(token),
        json={"collection_ids": [coll_id]},
    )

    resp = await client.get(
        f"{API}/books?collection_id={coll_id}", headers=_auth_headers(token)
    )
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["id"] == a


@pytest.mark.asyncio
async def test_search_books_by_title(client):
    _, token = await _token(client)
    await _upload_pdf(client, token, "Pyramid Texts")
    await _upload_pdf(client, token, "Coffin Texts")

    resp = await client.get(
        f"{API}/books?search=pyramid", headers=_auth_headers(token)
    )
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["title"] == "Pyramid Texts"


@pytest.mark.asyncio
async def test_books_pagination(client):
    _, token = await _token(client)
    for i in range(3):
        await _upload_pdf(client, token, f"Book {i}")

    page1 = await client.get(
        f"{API}/books?page=1&page_size=2", headers=_auth_headers(token)
    )
    assert page1.json()["total"] == 3
    assert len(page1.json()["items"]) == 2

    page2 = await client.get(
        f"{API}/books?page=2&page_size=2", headers=_auth_headers(token)
    )
    assert len(page2.json()["items"]) == 1


@pytest.mark.asyncio
async def test_delete_collection_keeps_books(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]
    coll_id = await _create_collection(client, token, "Egypt")
    await client.put(
        f"{API}/books/{book_id}/collections",
        headers=_auth_headers(token),
        json={"collection_ids": [coll_id]},
    )

    resp = await client.delete(
        f"{API}/collections/{coll_id}", headers=_auth_headers(token)
    )
    assert resp.status_code == 204

    listing = await client.get(f"{API}/collections", headers=_auth_headers(token))
    assert listing.json() == []
    book = await client.get(f"{API}/books/{book_id}", headers=_auth_headers(token))
    assert book.json()["collection_ids"] == []


@pytest.mark.asyncio
async def test_collection_isolated_per_user(client):
    _, token1 = await _token(client)
    coll_id = await _create_collection(client, token1, "Egypt")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        resp = await other.delete(
            f"{API}/collections/{coll_id}", headers=_auth_headers(token2)
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rename_collection(client):
    _, token = await _token(client)
    coll_id = await _create_collection(client, token, "Egpt")

    resp = await client.patch(
        f"{API}/collections/{coll_id}",
        headers=_auth_headers(token),
        json={"name": "Egypt"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Egypt"

    listing = await client.get(f"{API}/collections", headers=_auth_headers(token))
    assert [c["name"] for c in listing.json()] == ["Egypt"]


# --- Auto-detected metadata on upload -------------------------------------


@pytest.mark.asyncio
async def test_import_without_title_falls_back_to_filename(client):
    _, token = await _token(client)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        files={"file": ("My Great Book.pdf", FAKE_PDF, "application/pdf")},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "My Great Book"
    assert body["author"] is None


@pytest.mark.asyncio
async def test_import_blank_title_falls_back_to_filename(client):
    _, token = await _token(client)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": "   "},
        files={"file": ("Spaced.pdf", FAKE_PDF, "application/pdf")},
    )
    assert response.status_code == 201
    assert response.json()["title"] == "Spaced"


@pytest.mark.asyncio
async def test_import_client_title_wins(client):
    _, token = await _token(client)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": "Chosen", "author": "Me"},
        files={"file": ("ignored.pdf", FAKE_PDF, "application/pdf")},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Chosen"
    assert body["author"] == "Me"


@pytest.mark.asyncio
async def test_import_extracts_metadata_from_real_pdf(client):
    _, token = await _token(client)
    pdf = _pdf_with_metadata("Embedded Title", "Embedded Author", pages=2)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        files={"file": ("whatever.pdf", pdf, "application/pdf")},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Embedded Title"
    assert body["author"] == "Embedded Author"
    assert body["page_count"] == 2


@pytest.mark.asyncio
async def test_import_real_pdf_no_metadata_uses_filename_and_page_count(client):
    _, token = await _token(client)
    pdf = _pdf_with_metadata(pages=3)
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        files={"file": ("Fallback Name.pdf", pdf, "application/pdf")},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Fallback Name"
    assert body["author"] is None
    assert body["page_count"] == 3


@pytest.mark.asyncio
async def test_import_fake_pdf_has_null_page_count(client):
    _, token = await _token(client)
    response = await _upload_pdf(client, token)
    assert response.status_code == 201
    assert response.json()["page_count"] is None


# --- PATCH /books/{id} (edit details) -------------------------------------


@pytest.mark.asyncio
async def test_patch_updates_title(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"title": "Renamed"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Renamed"
    assert body["author"] == "Test Author"  # untouched


@pytest.mark.asyncio
async def test_patch_updates_author(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"author": "New Author"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["author"] == "New Author"
    assert body["title"] == "Test Book"  # untouched


@pytest.mark.asyncio
async def test_patch_clears_author(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"author": None},
    )
    assert response.status_code == 200
    assert response.json()["author"] is None


@pytest.mark.asyncio
async def test_patch_empty_body_changes_nothing(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Test Book"
    assert body["author"] == "Test Author"


@pytest.mark.asyncio
async def test_patch_strips_title(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"title": "  Trimmed  "},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Trimmed"


@pytest.mark.asyncio
async def test_patch_rejects_empty_title(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"title": ""},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_patch_rejects_null_title(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"title": None},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_patch_rejects_whitespace_title_and_keeps_value(client):
    _, token = await _token(client)
    book_id = (await _upload_pdf(client, token)).json()["id"]

    response = await client.patch(
        f"{API}/books/{book_id}",
        headers=_auth_headers(token),
        json={"title": "   "},
    )
    assert response.status_code == 422
    book = await client.get(f"{API}/books/{book_id}", headers=_auth_headers(token))
    assert book.json()["title"] == "Test Book"  # not overwritten with empty


@pytest.mark.asyncio
async def test_patch_missing_book_returns_404(client):
    _, token = await _token(client)
    response = await client.patch(
        f"{API}/books/999999",
        headers=_auth_headers(token),
        json={"title": "Nope"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_patch_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = (await _upload_pdf(client, token1)).json()["id"]

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        resp = await other.patch(
            f"{API}/books/{book_id}",
            headers=_auth_headers(token2),
            json={"title": "Hijacked"},
        )
        assert resp.status_code == 404


# --- metadata service -----------------------------------------------------


@pytest.mark.asyncio
async def test_extract_metadata_fake_pdf_returns_none():
    meta = await extract_pdf_metadata(FAKE_PDF)
    assert meta == {"title": None, "author": None, "page_count": None}


@pytest.mark.asyncio
async def test_extract_metadata_non_pdf_returns_none():
    meta = await extract_pdf_metadata(b"not a pdf at all")
    assert meta == {"title": None, "author": None, "page_count": None}


@pytest.mark.asyncio
async def test_extract_metadata_real_pdf():
    meta = await extract_pdf_metadata(_pdf_with_metadata("X", "Y", pages=2))
    assert meta["title"] == "X"
    assert meta["author"] == "Y"
    assert meta["page_count"] == 2


@pytest.mark.asyncio
async def test_extract_metadata_strips_whitespace():
    meta = await extract_pdf_metadata(_pdf_with_metadata("  Spaced  "))
    assert meta["title"] == "Spaced"
