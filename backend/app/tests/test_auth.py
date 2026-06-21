import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

API = "/api/v1"
PASSWORD = "Passw0rd!"


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


@pytest.mark.asyncio
async def test_health(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_register_duplicate_returns_409(client):
    email = await _register(client)
    response = await client.post(
        f"{API}/auth/register",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "E-mail já cadastrado"


@pytest.mark.asyncio
async def test_login_returns_access_token_and_httponly_cookie(client):
    email = await _register(client)
    response = await client.post(
        f"{API}/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]

    cookie = response.headers.get("set-cookie", "")
    assert "anubis_refresh=" in cookie
    assert "HttpOnly" in cookie
    assert "Path=/api/v1/auth" in cookie


@pytest.mark.asyncio
async def test_users_me_requires_auth(client):
    response = await client.get(f"{API}/users/me")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_users_me_with_access_token(client):
    email = await _register(client)
    login = await client.post(
        f"{API}/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    token = login.json()["access_token"]

    response = await client.get(
        f"{API}/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["email"] == email


@pytest.mark.asyncio
async def test_refresh_uses_cookie_only(client):
    email = await _register(client)
    await client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})

    response = await client.post(f"{API}/auth/refresh")
    assert response.status_code == 200
    assert response.json()["access_token"]


@pytest.mark.asyncio
async def test_logout_clears_refresh_cookie(client):
    email = await _register(client)
    await client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})

    response = await client.post(f"{API}/auth/logout")
    assert response.status_code == 204

    refresh = await client.post(f"{API}/auth/refresh")
    assert refresh.status_code == 401


def _cookie_value(response, name: str) -> str:
    header = response.headers.get("set-cookie", "")
    for part in header.split(";"):
        if part.strip().startswith(f"{name}="):
            return part.split("=", 1)[1]
    raise AssertionError(f"cookie {name} not found in {header}")


@pytest.mark.asyncio
async def test_refresh_rotates_cookie(client):
    email = await _register(client)
    login = await client.post(
        f"{API}/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    original = _cookie_value(login, "anubis_refresh")

    refresh = await client.post(f"{API}/auth/refresh")
    assert refresh.status_code == 200
    rotated = _cookie_value(refresh, "anubis_refresh")
    assert rotated != original


@pytest.mark.asyncio
async def test_reused_refresh_token_rejected(client):
    email = await _register(client)
    login = await client.post(
        f"{API}/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    stale = _cookie_value(login, "anubis_refresh")

    rotate = await client.post(f"{API}/auth/refresh")
    assert rotate.status_code == 200

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={"anubis_refresh": stale},
    ) as stale_client:
        reuse = await stale_client.post(f"{API}/auth/refresh")
    assert reuse.status_code == 401