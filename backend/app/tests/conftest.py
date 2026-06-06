import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.db.session import engine
from app.main import app


@pytest_asyncio.fixture
async def client():
    # Reset the pool so each test gets a fresh connection on the current event loop.
    await engine.dispose()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    await engine.dispose()