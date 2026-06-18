import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.main import app
from app.models.sketch import Sketch, SketchGroup
from app.services import storage as storage_module

API = "/api/v1"
PASSWORD = "Passw0rd!"
FAKE_PDF = b"%PDF-1.4\n% fake pdf content\n"
EXCALIDRAW_SCENE = (
    '{"type":"excalidraw","version":2,"source":"local",'
    '"elements":[{"id":"a1","type":"freedraw"}],'
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


async def _create_group(client, token: str, book_id: int, name: str = "Mechanics"):
    return await client.post(
        f"{API}/books/{book_id}/sketch-groups",
        headers=_auth_headers(token),
        json={"name": name},
    )


async def _create_sketch(client, token: str, book_id: int, **overrides):
    payload = {"title": "Problem 1", "content": EXCALIDRAW_SCENE, "page": 12}
    payload.update(overrides)
    return await client.post(
        f"{API}/books/{book_id}/sketches",
        headers=_auth_headers(token),
        json=payload,
    )


@pytest.mark.asyncio
async def test_create_sketch_group_and_sketch(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    group = (await _create_group(client, token, book_id)).json()

    response = await _create_sketch(client, token, book_id, group_id=group["id"])

    assert response.status_code == 201
    body = response.json()
    assert body["book_id"] == book_id
    assert body["group_id"] == group["id"]
    assert body["title"] == "Problem 1"
    assert body["content"] == EXCALIDRAW_SCENE
    assert body["page"] == 12
    assert body["created_at"]
    assert body["updated_at"]


@pytest.mark.asyncio
async def test_list_groups_ordered_by_position(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    first = (await _create_group(client, token, book_id, "First")).json()
    second = (await _create_group(client, token, book_id, "Second")).json()

    renamed = await client.patch(
        f"{API}/books/{book_id}/sketch-groups/{second['id']}",
        headers=_auth_headers(token),
        json={"name": "Second renamed", "position": 0},
    )
    assert renamed.status_code == 200

    response = await client.get(
        f"{API}/books/{book_id}/sketch-groups", headers=_auth_headers(token)
    )
    assert response.status_code == 200
    items = response.json()
    assert [g["id"] for g in items] == [second["id"], first["id"]]
    assert items[0]["name"] == "Second renamed"


@pytest.mark.asyncio
async def test_list_sketches_newest_first(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    first = (await _create_sketch(client, token, book_id, title="First")).json()
    second = (await _create_sketch(client, token, book_id, title="Second")).json()

    response = await client.get(
        f"{API}/books/{book_id}/sketches", headers=_auth_headers(token)
    )
    assert response.status_code == 200
    assert [s["id"] for s in response.json()] == [second["id"], first["id"]]


@pytest.mark.asyncio
async def test_patch_sketch_clears_group_and_page(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    group = (await _create_group(client, token, book_id)).json()
    sketch = (await _create_sketch(client, token, book_id, group_id=group["id"])).json()

    response = await client.patch(
        f"{API}/books/{book_id}/sketches/{sketch['id']}",
        headers=_auth_headers(token),
        json={"group_id": None, "page": None},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["group_id"] is None
    assert body["page"] is None


@pytest.mark.asyncio
async def test_create_sketch_rejects_group_from_another_user(client):
    _, token1 = await _token(client)
    book_id = await _make_book(client, token1)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)
        other_book = await _make_book(other, token2, "Other Book")
        group = (await _create_group(other, token2, other_book)).json()

        response = await _create_sketch(
            client, token1, book_id, group_id=group["id"]
        )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_group_moves_sketches_to_ungrouped(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    group = (await _create_group(client, token, book_id)).json()
    sketch = (await _create_sketch(client, token, book_id, group_id=group["id"])).json()

    deleted = await client.delete(
        f"{API}/books/{book_id}/sketch-groups/{group['id']}",
        headers=_auth_headers(token),
    )
    assert deleted.status_code == 204

    fetched = await client.get(
        f"{API}/books/{book_id}/sketches/{sketch['id']}",
        headers=_auth_headers(token),
    )
    assert fetched.status_code == 200
    assert fetched.json()["group_id"] is None


@pytest.mark.asyncio
async def test_sketches_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = await _make_book(client, token1)
    group = (await _create_group(client, token1, book_id)).json()
    sketch = (await _create_sketch(client, token1, book_id, group_id=group["id"])).json()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)

        assert (
            await other.get(
                f"{API}/books/{book_id}/sketch-groups", headers=_auth_headers(token2)
            )
        ).status_code == 404
        assert (
            await other.patch(
                f"{API}/books/{book_id}/sketches/{sketch['id']}",
                headers=_auth_headers(token2),
                json={"title": "Hijack"},
            )
        ).status_code == 404
        assert (
            await other.delete(
                f"{API}/books/{book_id}/sketch-groups/{group['id']}",
                headers=_auth_headers(token2),
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_sketches_cascade_on_book_delete(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    group = (await _create_group(client, token, book_id)).json()
    assert (await _create_sketch(client, token, book_id, group_id=group["id"])).status_code == 201

    deleted = await client.delete(
        f"{API}/books/{book_id}", headers=_auth_headers(token)
    )
    assert deleted.status_code == 204

    async with AsyncSessionLocal() as db:
        sketches = (
            await db.scalars(select(Sketch).where(Sketch.book_id == book_id))
        ).all()
        groups = (
            await db.scalars(select(SketchGroup).where(SketchGroup.book_id == book_id))
        ).all()
    assert sketches == []
    assert groups == []


@pytest.mark.asyncio
async def test_reader_state_accepts_sketches_panel(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    group = (await _create_group(client, token, book_id)).json()
    sketch = (await _create_sketch(client, token, book_id, group_id=group["id"])).json()

    response = await client.put(
        f"{API}/books/{book_id}/reader-state",
        headers=_auth_headers(token),
        json={
            "version": 1,
            "zoom_pct": 120,
            "panel": "sketches",
            "panel_width_px": 640,
            "notes": {"view": "list", "active_id": None, "search": ""},
            "diagrams": {"view": "list", "active_id": None},
            "sketches": {
                "view": "edit",
                "active_id": sketch["id"],
                "active_group_id": group["id"],
                "search": "problem",
            },
        },
    )

    assert response.status_code == 200
    state = response.json()["reader_state"]
    assert state["panel"] == "sketches"
    assert state["sketches"]["active_id"] == sketch["id"]
    assert state["sketches"]["active_group_id"] == group["id"]
    assert state["sketches"]["search"] == "problem"
