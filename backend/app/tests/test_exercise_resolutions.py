import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.main import app
from app.models.exercise_resolution import ExerciseAttempt, ExerciseResolution
from app.services import ai
from app.services import storage as storage_module

API = "/api/v1"
PASSWORD = "Passw0rd!"
FAKE_PDF = b"%PDF-1.4\n% fake pdf content\n"
REGION = {"x0": 0.1, "y0": 0.12, "x1": 0.5, "y1": 0.4}


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


async def _create_resolution(client, token: str, book_id: int, **overrides):
    payload = {
        "title": "Exercício 4",
        "page": 12,
        "region": REGION,
        "statement": "Resolva a equação x^2 = 4.",
    }
    payload.update(overrides)
    return await client.post(
        f"{API}/books/{book_id}/exercise-resolutions",
        headers=_auth_headers(token),
        json=payload,
    )


@pytest.mark.asyncio
async def test_create_exercise_resolution(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await _create_resolution(client, token, book_id)

    assert response.status_code == 201
    body = response.json()
    assert body["book_id"] == book_id
    assert body["title"] == "Exercício 4"
    assert body["page"] == 12
    assert body["region"] == REGION
    assert body["statement"] == "Resolva a equação x^2 = 4."
    assert body["status"] == "pending"
    assert body["ai_feedback"] is None
    assert body["created_at"]


@pytest.mark.asyncio
async def test_create_rejects_invalid_region(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)

    response = await _create_resolution(
        client, token, book_id, region={"x0": 0.5, "y0": 0.1, "x1": 0.5, "y1": 0.4}
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_list_resolutions_ordered_by_page(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    far = (await _create_resolution(client, token, book_id, page=20)).json()
    near = (await _create_resolution(client, token, book_id, page=5)).json()

    response = await client.get(
        f"{API}/books/{book_id}/exercise-resolutions", headers=_auth_headers(token)
    )
    assert response.status_code == 200
    assert [r["id"] for r in response.json()] == [near["id"], far["id"]]


@pytest.mark.asyncio
async def test_patch_updates_status_and_content(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (await _create_resolution(client, token, book_id)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/exercise-resolutions/{res['id']}",
        headers=_auth_headers(token),
        json={
            "status": "completed",
            "latex_content": "x = 2",
            "ai_feedback": "Looks correct.",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["latex_content"] == "x = 2"
    assert body["ai_feedback"] == "Looks correct."


@pytest.mark.asyncio
async def test_patch_rejects_invalid_status(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (await _create_resolution(client, token, book_id)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/exercise-resolutions/{res['id']}",
        headers=_auth_headers(token),
        json={"status": "bogus"},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_patch_rejects_empty_title(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (await _create_resolution(client, token, book_id)).json()

    response = await client.patch(
        f"{API}/books/{book_id}/exercise-resolutions/{res['id']}",
        headers=_auth_headers(token),
        json={"title": "   "},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_create_and_list_attempts(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (
        await _create_resolution(client, token, book_id, latex_content="first try")
    ).json()

    created = await client.post(
        f"{API}/books/{book_id}/exercise-resolutions/{res['id']}/attempts",
        headers=_auth_headers(token),
    )
    assert created.status_code == 201
    assert created.json()["latex_content"] == "first try"

    listed = await client.get(
        f"{API}/books/{book_id}/exercise-resolutions/{res['id']}/attempts",
        headers=_auth_headers(token),
    )
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert listed.json()[0]["resolution_id"] == res["id"]


@pytest.mark.asyncio
async def test_resolutions_isolated_per_user(client):
    _, token1 = await _token(client)
    book_id = await _make_book(client, token1)
    res = (await _create_resolution(client, token1, book_id)).json()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as other:
        _, token2 = await _token(other)

        assert (
            await other.get(
                f"{API}/books/{book_id}/exercise-resolutions",
                headers=_auth_headers(token2),
            )
        ).status_code == 404
        assert (
            await other.patch(
                f"{API}/books/{book_id}/exercise-resolutions/{res['id']}",
                headers=_auth_headers(token2),
                json={"title": "Hijack"},
            )
        ).status_code == 404
        assert (
            await other.post(
                f"{API}/books/{book_id}/exercise-resolutions/{res['id']}/attempts",
                headers=_auth_headers(token2),
            )
        ).status_code == 404


@pytest.mark.asyncio
async def test_resolutions_cascade_on_book_delete(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (await _create_resolution(client, token, book_id)).json()
    attempt = (
        await client.post(
            f"{API}/books/{book_id}/exercise-resolutions/{res['id']}/attempts",
            headers=_auth_headers(token),
        )
    ).json()

    deleted = await client.delete(
        f"{API}/books/{book_id}", headers=_auth_headers(token)
    )
    assert deleted.status_code == 204

    async with AsyncSessionLocal() as db:
        resolutions = (
            await db.scalars(
                select(ExerciseResolution).where(
                    ExerciseResolution.book_id == book_id
                )
            )
        ).all()
        attempts = (
            await db.scalars(
                select(ExerciseAttempt).where(ExerciseAttempt.id == attempt["id"])
            )
        ).all()
    assert resolutions == []
    assert attempts == []


@pytest.mark.asyncio
async def test_exercise_ai_requires_configuration(client):
    if ai.configured():
        pytest.skip("AI is configured in this environment")
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (await _create_resolution(client, token, book_id)).json()

    response = await client.post(
        f"{API}/books/{book_id}/exercise-resolutions/{res['id']}/ai",
        headers=_auth_headers(token),
        json={"mode": "hint"},
    )
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_reader_state_accepts_exercises_panel(client):
    _, token = await _token(client)
    book_id = await _make_book(client, token)
    res = (await _create_resolution(client, token, book_id)).json()

    response = await client.put(
        f"{API}/books/{book_id}/reader-state",
        headers=_auth_headers(token),
        json={
            "version": 1,
            "zoom_pct": 100,
            "panel": "exercises",
            "panel_width_px": 520,
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
            "exercises": {"view": "edit", "active_id": res["id"], "search": "ex"},
        },
    )

    assert response.status_code == 200
    state = response.json()["reader_state"]
    assert state["panel"] == "exercises"
    assert state["exercises"]["active_id"] == res["id"]
    assert state["exercises"]["search"] == "ex"
