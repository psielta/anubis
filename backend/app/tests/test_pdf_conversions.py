"""PDF conversion module tests."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pymupdf
import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from app.crud import outbox as outbox_crud
from app.crud import pdf_conversion as job_crud
from app.db.session import AsyncSessionLocal, engine
from app.models.outbox import OutboxEvent, OutboxEventType, OutboxStatus
from app.models.pdf_conversion import (
    PdfConversionErrorCode,
    PdfConversionJob,
    PdfConversionStatus,
)
from app.services import storage as storage_module
from app.services.sse_service import _event_key, stream_job_events
from app.workers.pdf_conversion_worker import process_conversion

API = "/api/v1"
PASSWORD = "Passw0rd!"


def _email() -> str:
    return f"test-{uuid.uuid4().hex[:12]}@anubis.dev"


async def _register(client: AsyncClient, email: str | None = None) -> str:
    addr = email or _email()
    response = await client.post(
        f"{API}/auth/register",
        json={"email": addr, "password": PASSWORD, "full_name": "Test User"},
    )
    assert response.status_code == 201
    return addr


async def _token(client: AsyncClient, email: str | None = None) -> tuple[str, str]:
    addr = await _register(client, email)
    login = await client.post(
        f"{API}/auth/login",
        json={"email": addr, "password": PASSWORD},
    )
    assert login.status_code == 200
    return addr, login.json()["access_token"]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _make_text_pdf(text: str, pages: int = 1) -> bytes:
    doc = pymupdf.open()
    for _ in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), text)
    data = doc.tobytes()
    doc.close()
    return data


def _make_scanned_pdf() -> bytes:
    doc = pymupdf.open()
    doc.new_page()
    data = doc.tobytes()
    doc.close()
    return data


@pytest.fixture(autouse=True)
def mock_storage(monkeypatch):
    store: dict[str, bytes] = {}

    async def upload(key: str, body: bytes, content_type: str) -> None:
        store[key] = body

    async def read_bytes(key: str) -> bytes:
        return store[key]

    async def delete(key: str) -> None:
        store.pop(key, None)

    monkeypatch.setattr(storage_module.storage, "upload", upload)
    monkeypatch.setattr(storage_module.storage, "read_bytes", read_bytes)
    monkeypatch.setattr(storage_module.storage, "delete", delete)
    monkeypatch.setattr(storage_module.storage, "_store", store, raising=False)


@pytest.mark.asyncio
async def test_upload_creates_job_and_outbox_atomically(client):
    _, token = await _token(client)
    pdf = _make_text_pdf("Hello conversion world")
    files = {"file": ("test.pdf", pdf, "application/pdf")}

    with patch(
        "app.services.pdf_conversion_service.pdf_split_service.count_pages",
        return_value=1,
    ):
        resp = await client.post(
            f"{API}/pdf-conversions",
            headers=_auth(token),
            files=files,
        )

    assert resp.status_code == 201
    job_id = resp.json()["job_id"]

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, uuid.UUID(job_id))
        assert job is not None
        assert job.status == PdfConversionStatus.PENDING.value
        assert job.progress == 10

        events = (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == job.id)
            )
        ).scalars().all()
        assert len(events) == 1
        assert events[0].event_type == OutboxEventType.PDF_CONVERSION_REQUESTED.value
        assert events[0].status == OutboxStatus.PENDING.value


@pytest.mark.asyncio
async def test_list_jobs_returns_only_current_user(client):
    _, token_a = await _token(client)
    _, token_b = await _token(client)
    pdf = _make_text_pdf("List jobs test")

    with patch(
        "app.services.pdf_conversion_service.pdf_split_service.count_pages",
        return_value=1,
    ):
        created = await client.post(
            f"{API}/pdf-conversions",
            headers=_auth(token_a),
            files={"file": ("mine.pdf", pdf, "application/pdf")},
        )
    assert created.status_code == 201
    job_id = created.json()["job_id"]

    listed_a = await client.get(f"{API}/pdf-conversions", headers=_auth(token_a))
    assert listed_a.status_code == 200
    ids_a = {item["id"] for item in listed_a.json()}
    assert job_id in ids_a

    listed_b = await client.get(f"{API}/pdf-conversions", headers=_auth(token_b))
    assert listed_b.status_code == 200
    ids_b = {item["id"] for item in listed_b.json()}
    assert job_id not in ids_b


async def test_upload_rejects_non_pdf(client):
    _, token = await _token(client)
    resp = await client.post(
        f"{API}/pdf-conversions",
        headers=_auth(token),
        files={"file": ("x.txt", b"not pdf", "text/plain")},
    )
    assert resp.status_code == 415


@pytest.mark.asyncio
async def test_outbox_skip_locked_two_workers():
    await engine.dispose()
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(OutboxEvent)
            .where(OutboxEvent.status == OutboxStatus.PENDING.value)
            .values(status=OutboxStatus.DONE.value, processed_at=datetime.now(UTC))
        )
        job = await job_crud.create_job(
            db,
            owner_id=1,
            tenant_id=1,
            original_filename="a.pdf",
            input_file_path="k",
        )
        await outbox_crud.enqueue(
            db,
            aggregate_id=job.id,
            event_type=OutboxEventType.PDF_CONVERSION_REQUESTED,
        )
        await db.commit()
        agg_id = job.id

    async def try_claim() -> OutboxEvent | None:
        async with AsyncSessionLocal() as session:
            ev = await outbox_crud.claim_next(session, worker_id=uuid.uuid4().hex)
            if ev:
                await session.commit()
            return ev

    r1, r2 = await asyncio.gather(try_claim(), try_claim())
    claimed = [r for r in (r1, r2) if r is not None]
    assert len(claimed) == 1
    assert claimed[0].aggregate_id == agg_id


@pytest.mark.asyncio
async def test_scanned_pdf_fails_with_scanned_no_text():
    await engine.dispose()
    job_id: uuid.UUID
    async with AsyncSessionLocal() as db:
        job = await job_crud.create_job(
            db,
            owner_id=1,
            tenant_id=1,
            original_filename="scan.pdf",
            input_file_path="users/1/conversions/x/input.pdf",
        )
        job.page_count = 1
        job.status = PdfConversionStatus.PROCESSING.value
        job_id = job.id
        await storage_module.storage.upload(
            job.input_file_path, _make_scanned_pdf(), "application/pdf"
        )
        event = await outbox_crud.enqueue(
            db,
            aggregate_id=job.id,
            event_type=OutboxEventType.PDF_CONVERSION_REQUESTED,
        )
        await db.commit()
        event_id = event.id

    async with AsyncSessionLocal() as db:
        event = await db.get(OutboxEvent, event_id)
        job = await db.get(PdfConversionJob, job_id)
        assert event is not None and job is not None
        with patch(
            "app.workers.pdf_conversion_worker.markitdown_service.convert_page",
            return_value="",
        ):
            await process_conversion(db, event)
            await db.commit()

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, job_id)
        assert job is not None
        assert job.status == PdfConversionStatus.FAILED.value
        assert job.error_code == PdfConversionErrorCode.SCANNED_NO_TEXT.value


@pytest.mark.asyncio
async def test_idempotent_resume_from_chunking_stage():
    await engine.dispose()
    full_md = "## Title\n\nBody text for chunking."
    job_id: uuid.UUID
    async with AsyncSessionLocal() as db:
        job = await job_crud.create_job(
            db,
            owner_id=1,
            tenant_id=1,
            original_filename="doc.pdf",
            input_file_path="users/1/conversions/y/input.pdf",
        )
        job.status = PdfConversionStatus.CHUNKING.value
        job.output_markdown_path = "users/1/conversions/y/output.md"
        job.page_count = 1
        job_id = job.id
        await storage_module.storage.upload(
            job.output_markdown_path, full_md.encode(), "text/markdown"
        )
        event = await outbox_crud.enqueue(
            db,
            aggregate_id=job.id,
            event_type=OutboxEventType.PDF_CONVERSION_REQUESTED,
        )
        await db.commit()
        event_id = event.id

    async with AsyncSessionLocal() as db:
        event = await db.get(OutboxEvent, event_id)
        assert event is not None
        await process_conversion(db, event)
        await db.commit()

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, job_id)
        assert job is not None
        assert job.status == PdfConversionStatus.COMPLETED.value
        chunks = await job_crud.list_chunk_summaries(db, job.id)
        assert len(chunks) >= 1


@pytest.mark.asyncio
async def test_retry_only_from_failed(client):
    _, token = await _token(client)
    fake_id = uuid.uuid4()
    resp = await client.post(
        f"{API}/pdf-conversions/{fake_id}/retry",
        headers=_auth(token),
    )
    assert resp.status_code == 404

    pdf = _make_text_pdf("retry test")
    with patch(
        "app.services.pdf_conversion_service.pdf_split_service.count_pages",
        return_value=1,
    ):
        created = await client.post(
            f"{API}/pdf-conversions",
            headers=_auth(token),
            files={"file": ("r.pdf", pdf, "application/pdf")},
        )
    job_id = uuid.UUID(created.json()["job_id"])

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, job_id)
        assert job is not None
        job.status = PdfConversionStatus.PROCESSING.value
        await db.commit()

    resp2 = await client.post(
        f"{API}/pdf-conversions/{job_id}/retry",
        headers=_auth(token),
    )
    assert resp2.status_code == 400

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, job_id)
        assert job is not None
        job.status = PdfConversionStatus.FAILED.value
        await db.commit()

    resp3 = await client.post(
        f"{API}/pdf-conversions/{job_id}/retry",
        headers=_auth(token),
    )
    assert resp3.status_code == 200
    assert resp3.json()["status"] == PdfConversionStatus.PENDING.value


@pytest.mark.asyncio
async def test_cancel_sets_flag(client):
    _, token = await _token(client)
    pdf = _make_text_pdf("cancel me")
    with patch(
        "app.services.pdf_conversion_service.pdf_split_service.count_pages",
        return_value=1,
    ):
        created = await client.post(
            f"{API}/pdf-conversions",
            headers=_auth(token),
            files={"file": ("c.pdf", pdf, "application/pdf")},
        )
    job_id = created.json()["job_id"]
    resp = await client.post(
        f"{API}/pdf-conversions/{job_id}/cancel",
        headers=_auth(token),
    )
    assert resp.status_code == 200

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, uuid.UUID(job_id))
        assert job is not None
        assert job.cancel_requested is True


@pytest.mark.asyncio
async def test_sse_subscribe_before_snapshot_order():
    job_id = uuid.uuid4()
    job = PdfConversionJob(
        id=job_id,
        owner_id=1,
        tenant_id=1,
        original_filename="s.pdf",
        status=PdfConversionStatus.PROCESSING.value,
        progress=40,
        input_file_path="k",
    )

    subscribe_order: list[str] = []
    fetch_order: list[str] = []

    class FakePubSub:
        async def subscribe(self, channel: str) -> None:
            subscribe_order.append("subscribe")

        async def unsubscribe(self, channel: str) -> None:
            pass

        async def aclose(self) -> None:
            pass

        async def get_message(self, **kwargs):
            await asyncio.sleep(0.05)
            return None

    redis = MagicMock()
    redis.connect = AsyncMock()
    redis.pubsub = FakePubSub

    async def fetch_job():
        fetch_order.append("fetch")
        return job

    frames: list[str] = []
    async for frame in stream_job_events(
        job_id, redis, fetch_job, heartbeat_seconds=999
    ):
        frames.append(frame)
        if "data:" in frame:
            break

    assert subscribe_order == ["subscribe"]
    assert fetch_order == ["fetch"]
    assert subscribe_order[0] == "subscribe"
    assert fetch_order[0] == "fetch"
    assert frames[0].startswith("event: progress")


@pytest.mark.asyncio
async def test_sse_dedup_keys():
    a = {"timestamp": "t", "seq": 1, "status": "processing", "progress": 10}
    b = {"timestamp": "t", "seq": 1, "status": "processing", "progress": 10}
    c = {"timestamp": "t", "seq": 2, "status": "processing", "progress": 20}
    assert _event_key(a) == _event_key(b)
    assert _event_key(a) != _event_key(c)


@pytest.mark.asyncio
async def test_authz_other_user_cannot_read_job(client):
    _, token_a = await _token(client)
    _, token_b = await _token(client)
    pdf = _make_text_pdf("secret")
    with patch(
        "app.services.pdf_conversion_service.pdf_split_service.count_pages",
        return_value=1,
    ):
        created = await client.post(
            f"{API}/pdf-conversions",
            headers=_auth(token_a),
            files={"file": ("a.pdf", pdf, "application/pdf")},
        )
    job_id = created.json()["job_id"]
    resp = await client.get(
        f"{API}/pdf-conversions/{job_id}",
        headers=_auth(token_b),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_worker_timeout_on_slow_convert():
    await engine.dispose()
    pdf = _make_text_pdf("slow", pages=1)
    async with AsyncSessionLocal() as db:
        job = await job_crud.create_job(
            db,
            owner_id=1,
            tenant_id=1,
            original_filename="slow.pdf",
            input_file_path="users/1/conversions/slow/input.pdf",
        )
        job.status = PdfConversionStatus.PROCESSING.value
        job_id = job.id
        await storage_module.storage.upload(job.input_file_path, pdf, "application/pdf")
        event = await outbox_crud.enqueue(
            db,
            aggregate_id=job.id,
            event_type=OutboxEventType.PDF_CONVERSION_REQUESTED,
        )
        await db.commit()
        event_id = event.id

    def slow_convert(_page):
        import time

        time.sleep(2)
        return "late"

    async with AsyncSessionLocal() as db:
        event = await db.get(OutboxEvent, event_id)
        job = await db.get(PdfConversionJob, job_id)
        assert event is not None and job is not None
        with (
            patch(
                "app.workers.pdf_conversion_worker.settings.PDF_CONVERSION_TIMEOUT_SECONDS",
                0.1,
            ),
            patch(
                "app.workers.pdf_conversion_worker.markitdown_service.convert_page",
                side_effect=slow_convert,
            ),
        ):
            await process_conversion(db, event)
            await db.commit()

    async with AsyncSessionLocal() as db:
        job = await job_crud.get_by_id(db, job_id)
        assert job is not None
        assert job.status == PdfConversionStatus.FAILED.value
        assert job.error_code == PdfConversionErrorCode.TIMEOUT.value


@pytest.mark.asyncio
async def test_worker_cancel_between_pages():
    await engine.dispose()
    pdf = _make_text_pdf("page", pages=2)
    async with AsyncSessionLocal() as db:
        job = await job_crud.create_job(
            db,
            owner_id=1,
            tenant_id=1,
            original_filename="p.pdf",
            input_file_path="users/1/conversions/z/input.pdf",
        )
        job.cancel_requested = True
        job.status = PdfConversionStatus.PROCESSING.value
        await storage_module.storage.upload(
            job.input_file_path, pdf, "application/pdf"
        )
        event = await outbox_crud.enqueue(
            db,
            aggregate_id=job.id,
            event_type=OutboxEventType.PDF_CONVERSION_REQUESTED,
        )
        await db.commit()

        with patch(
            "app.workers.pdf_conversion_worker.markitdown_service.convert_page",
            return_value="text",
        ):
            await process_conversion(db, event)
            await db.commit()
            await db.refresh(job)

        assert job.status == PdfConversionStatus.CANCELED.value