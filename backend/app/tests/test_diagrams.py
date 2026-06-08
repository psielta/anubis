import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.main import app
from app.models.diagram import Diagram
from app.services import storage as storage_module

API = "/api/v1"
PASSWORD = "Passw0rd!"
FAKE_PDF = b"%PDF-1.4\n% fake pdf content\n"
EXCALIDRAW_SCENE = (
    '{"type":"excalidraw","version":2,"source":"local",'
    '"elements":[{"id":"a1","type":"rectangle"}],'
    '"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}'
)


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
    # Book create/delete touch object storage; diagram endpoints never do.
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


async def _create_diagram(client, token: str, book_id: int, **overrides):
    payload = {"title": "Cell map", "type": "mermaid", "content": "graph TD;A-->B"}
    payload.update(overrides)
    return await client.post(
        f"{API}/books/{book_id}/diagrams",
        headers=_auth_headers(token),
        json=payload,
    )


@pytest.mark.asyncio
async def test_create_diagram_returns_201(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await _create_diagram(client, token, book_id, page=5)
    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["book_id"] == book_id
    assert body["title"] == "Cell map"
    assert body["type"] == "mermaid"
    assert body["content"] == "graph TD;A-->B"
    assert body["page"] == 5
    assert body["created_at"]
    assert body["updated_at"]


@pytest.mark.asyncio
async def test_create_excalidraw_diagram_round_trips_scene(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await _create_diagram(
        client, token, book_id, title="Sketch", type="excalidraw",
        content=EXCALIDRAW_SCENE,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["type"] == "excalidraw"
    assert body["content"] == EXCALIDRAW_SCENE
    assert body["page"] is None


@pytest.mark.asyncio
async def test_list_diagrams_newest_first(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    first = (await _create_diagram(client, token, book_id, title="First")).json()
    second = (await _create_diagram(client, token, book_id, title="Second")).json()

    response = await client.get(
        f"{API}/books/{book_id}/diagrams", headers=_auth_headers(token)
    )
    assert response.status_code == 200
    items = response.json()
    assert [d["id"] for d in items] == [second["id"], first["id"]]


@pytest.mark.asyncio
async def test_get_diagram_by_id(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_diagram(client, token, book_id)).json()

    response = await client.get(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
    )
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


@pytest.mark.asyncio
async def test_get_missing_diagram_returns_404(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await client.get(
        f"{API}/books/{book_id}/diagrams/999999", headers=_auth_headers(token)
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_diagram_title_and_content(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_diagram(client, token, book_id, page=3)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
        json={"title": "Renamed", "content": "graph LR;X-->Y"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Renamed"
    assert body["content"] == "graph LR;X-->Y"
    assert body["type"] == "mermaid"  # immutable
    assert body["page"] == 3  # untouched


@pytest.mark.asyncio
async def test_patch_clears_page(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_diagram(client, token, book_id, page=7)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
        json={"page": None},
    )
    assert response.status_code == 200
    assert response.json()["page"] is None


@pytest.mark.asyncio
async def test_patch_empty_body_changes_nothing(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_diagram(client, token, book_id, page=4)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
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
    created = (await _create_diagram(client, token, book_id)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
        json={"title": "   "},
    )
    assert response.status_code == 422

    # title was not overwritten
    fetched = await client.get(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
    )
    assert fetched.json()["title"] == created["title"]


@pytest.mark.asyncio
async def test_create_rejects_invalid_type(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await _create_diagram(client, token, book_id, type="flowchart")
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_rejects_empty_title(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    empty = await _create_diagram(client, token, book_id, title="")
    assert empty.status_code == 422

    whitespace = await _create_diagram(client, token, book_id, title="   ")
    assert whitespace.status_code == 422


@pytest.mark.asyncio
async def test_delete_diagram_returns_204(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    created = (await _create_diagram(client, token, book_id)).json()

    response = await client.delete(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
    )
    assert response.status_code == 204

    fetched = await client.get(
        f"{API}/books/{book_id}/diagrams/{created['id']}",
        headers=_auth_headers(token),
    )
    assert fetched.status_code == 404

    listing = await client.get(
        f"{API}/books/{book_id}/diagrams", headers=_auth_headers(token)
    )
    assert listing.json() == []


@pytest.mark.asyncio
async def test_diagrams_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = await _make_book(client, token1)
    created = (await _create_diagram(client, token1, book_id)).json()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)

        # User 2 cannot list, read, patch or delete user 1's diagrams.
        assert (
            await other.get(
                f"{API}/books/{book_id}/diagrams", headers=_auth_headers(token2)
            )
        ).status_code == 404
        assert (
            await other.get(
                f"{API}/books/{book_id}/diagrams/{created['id']}",
                headers=_auth_headers(token2),
            )
        ).status_code == 404
        assert (
            await other.patch(
                f"{API}/books/{book_id}/diagrams/{created['id']}",
                headers=_auth_headers(token2),
                json={"title": "Hijack"},
            )
        ).status_code == 404
        assert (
            await other.delete(
                f"{API}/books/{book_id}/diagrams/{created['id']}",
                headers=_auth_headers(token2),
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_diagrams_cascade_on_book_delete(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    assert (await _create_diagram(client, token, book_id)).status_code == 201

    deleted = await client.delete(
        f"{API}/books/{book_id}", headers=_auth_headers(token)
    )
    assert deleted.status_code == 204

    # The FK ondelete=CASCADE must physically remove the diagram rows.
    async with AsyncSessionLocal() as db:
        rows = (
            await db.scalars(select(Diagram).where(Diagram.book_id == book_id))
        ).all()
    assert rows == []


@pytest.mark.asyncio
async def test_create_diagram_missing_book_returns_404(client):
    _, token = await _token(client)

    response = await _create_diagram(client, token, 999999)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_diagram_without_token_returns_401(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await client.get(f"{API}/books/{book_id}/diagrams")
    assert response.status_code == 401
