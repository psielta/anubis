import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.main import app
from app.models.note import Note
from app.services import storage as storage_module

API = "/api/v1"
PASSWORD = "Passw0rd!"
FAKE_PDF = b"%PDF-1.4\n% fake pdf content\n"
MARKDOWN = "# Osmosis\n\nWater moves across a membrane:\n\n- high to low\n- passive\n"


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
    # Book create/delete touch object storage; note endpoints never do.
    monkeypatch.setattr(storage_module.storage, "upload", AsyncMock())
    monkeypatch.setattr(storage_module.storage, "delete", AsyncMock())


async def _make_book(client, token: str, title: str = "Test Book") -> int:
    response = await client.post(
        f"{API}/books",
        headers=_auth_headers(token),
        data={"title": title, "author": "Test Author"},
        files={"file": ("book.pdf", FAKE_PDF, "application/pdf")},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_note(client, token: str, book_id: int, **overrides):
    payload = {"title": "Osmosis summary", "content": MARKDOWN}
    payload.update(overrides)
    return await client.post(
        f"{API}/books/{book_id}/notes",
        headers=_auth_headers(token),
        json=payload,
    )


@pytest.mark.asyncio
async def test_create_note_returns_201(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await _create_note(client, token, book_id, page=5)
    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["book_id"] == book_id
    assert body["title"] == "Osmosis summary"
    assert body["content"] == MARKDOWN
    assert body["page"] == 5
    assert body["created_at"]
    assert body["updated_at"]


@pytest.mark.asyncio
async def test_create_note_defaults_to_empty_content(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await client.post(
        f"{API}/books/{book_id}/notes",
        headers=_auth_headers(token),
        json={"title": "Just a title"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["content"] == ""
    assert body["page"] is None


@pytest.mark.asyncio
async def test_list_notes_newest_first(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    first = (await _create_note(client, token, book_id, title="First")).json()
    second = (await _create_note(client, token, book_id, title="Second")).json()

    response = await client.get(
        f"{API}/books/{book_id}/notes", headers=_auth_headers(token)
    )
    assert response.status_code == 200
    items = response.json()
    assert [n["id"] for n in items] == [second["id"], first["id"]]


@pytest.mark.asyncio
async def test_list_notes_search_matches_title_and_content(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    by_title = (
        await _create_note(client, token, book_id, title="Krebs cycle", content="TODO")
    ).json()
    by_content = (
        await _create_note(
            client, token, book_id, title="Doubts", content="Revisit the KREBS steps"
        )
    ).json()
    assert (
        await _create_note(client, token, book_id, title="Glycolysis", content="...")
    ).status_code == 201

    response = await client.get(
        f"{API}/books/{book_id}/notes",
        headers=_auth_headers(token),
        params={"q": "krebs"},
    )
    assert response.status_code == 200
    ids = {n["id"] for n in response.json()}
    assert ids == {by_title["id"], by_content["id"]}


@pytest.mark.asyncio
async def test_list_notes_search_treats_wildcards_literally(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    literal = (
        await _create_note(
            client, token, book_id, title="Stats", content="Confidence is 100% here"
        )
    ).json()
    assert (
        await _create_note(client, token, book_id, title="Other", content="No match")
    ).status_code == 201

    response = await client.get(
        f"{API}/books/{book_id}/notes",
        headers=_auth_headers(token),
        params={"q": "100%"},
    )
    assert response.status_code == 200
    assert [n["id"] for n in response.json()] == [literal["id"]]


@pytest.mark.asyncio
async def test_get_note_by_id(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_note(client, token, book_id)).json()

    response = await client.get(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
    )
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


@pytest.mark.asyncio
async def test_get_missing_note_returns_404(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await client.get(
        f"{API}/books/{book_id}/notes/999999", headers=_auth_headers(token)
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_note_title_and_content(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_note(client, token, book_id, page=3)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
        json={"title": "Renamed", "content": "## Updated\n\nNew text."},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Renamed"
    assert body["content"] == "## Updated\n\nNew text."
    assert body["page"] == 3  # untouched


@pytest.mark.asyncio
async def test_patch_clears_page(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_note(client, token, book_id, page=7)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
        json={"page": None},
    )
    assert response.status_code == 200
    assert response.json()["page"] is None


@pytest.mark.asyncio
async def test_patch_empty_body_changes_nothing(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_note(client, token, book_id, page=4)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
        json={},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == created["title"]
    assert body["content"] == created["content"]
    assert body["page"] == 4


@pytest.mark.asyncio
async def test_patch_rejects_whitespace_title(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_note(client, token, book_id)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
        json={"title": "   "},
    )
    assert response.status_code == 422

    # title was not overwritten
    fetched = await client.get(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
    )
    assert fetched.json()["title"] == created["title"]


@pytest.mark.asyncio
async def test_create_rejects_empty_title(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    empty = await _create_note(client, token, book_id, title="")
    assert empty.status_code == 422

    whitespace = await _create_note(client, token, book_id, title="   ")
    assert whitespace.status_code == 422


@pytest.mark.asyncio
async def test_delete_note_returns_204(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_note(client, token, book_id)).json()

    response = await client.delete(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
    )
    assert response.status_code == 204

    fetched = await client.get(
        f"{API}/books/{book_id}/notes/{created['id']}",
        headers=_auth_headers(token),
    )
    assert fetched.status_code == 404

    listing = await client.get(
        f"{API}/books/{book_id}/notes", headers=_auth_headers(token)
    )
    assert listing.json() == []


@pytest.mark.asyncio
async def test_notes_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = await _make_book(client, token1)
    created = (await _create_note(client, token1, book_id)).json()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)

        # User 2 cannot list, read, patch or delete user 1's notes.
        assert (
            await other.get(
                f"{API}/books/{book_id}/notes", headers=_auth_headers(token2)
            )
        ).status_code == 404
        assert (
            await other.get(
                f"{API}/books/{book_id}/notes/{created['id']}",
                headers=_auth_headers(token2),
            )
        ).status_code == 404
        assert (
            await other.patch(
                f"{API}/books/{book_id}/notes/{created['id']}",
                headers=_auth_headers(token2),
                json={"title": "Hijack"},
            )
        ).status_code == 404
        assert (
            await other.delete(
                f"{API}/books/{book_id}/notes/{created['id']}",
                headers=_auth_headers(token2),
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_notes_cascade_on_book_delete(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    assert (await _create_note(client, token, book_id)).status_code == 201

    deleted = await client.delete(
        f"{API}/books/{book_id}", headers=_auth_headers(token)
    )
    assert deleted.status_code == 204

    # The FK ondelete=CASCADE must physically remove the note rows.
    async with AsyncSessionLocal() as db:
        rows = (
            await db.scalars(select(Note).where(Note.book_id == book_id))
        ).all()
    assert rows == []


@pytest.mark.asyncio
async def test_create_note_missing_book_returns_404(client):
    _, token = await _token(client)

    response = await _create_note(client, token, 999999)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_note_without_token_returns_401(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await client.get(f"{API}/books/{book_id}/notes")
    assert response.status_code == 401
