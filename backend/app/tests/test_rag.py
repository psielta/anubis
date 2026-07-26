"""RAG activate / reprocess / status / query / worker tests."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pymupdf
import pytest
from httpx import AsyncClient
from sqlalchemy import select

from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.crud import outbox as outbox_crud
from app.crud import rag as rag_crud
from app.db.session import AsyncSessionLocal, engine
from app.models.outbox import OutboxEvent, OutboxEventType, OutboxStatus
from app.models.rag import RAG_EMBEDDING_DIM, RagStatus
from app.services import storage as storage_module
from app.services.gemini_embeddings import EmbeddingError
from app.workers.outbox_worker import process_one
from app.workers.rag_worker import process_rag_event
from sqlalchemy import update

API = "/api/v1"
PASSWORD = "Passw0rd!"


def _email() -> str:
    return f"rag-{uuid.uuid4().hex[:12]}@anubis.dev"


async def _register(client: AsyncClient, email: str | None = None) -> str:
    addr = email or _email()
    response = await client.post(
        f"{API}/auth/register",
        json={"email": addr, "password": PASSWORD, "full_name": "RAG User"},
    )
    assert response.status_code == 201, response.text
    return addr


async def _token(client: AsyncClient, email: str | None = None) -> tuple[str, str]:
    addr = await _register(client, email)
    login = await client.post(
        f"{API}/auth/login",
        json={"email": addr, "password": PASSWORD},
    )
    assert login.status_code == 200, login.text
    return addr, login.json()["access_token"]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _make_text_pdf(pages: list[str]) -> bytes:
    doc = pymupdf.open()
    for text_content in pages:
        page = doc.new_page()
        # Multi-paragraph content for chunking
        y = 72
        for para in text_content.split("\n\n"):
            page.insert_text((72, y), para[:500])
            y += 40
    data = doc.tobytes()
    doc.close()
    return data


def _fake_embedding(seed: float = 0.1) -> list[float]:
    # Deterministic unit-ish vector for similarity tests
    vec = [seed + (i % 7) * 0.001 for i in range(RAG_EMBEDDING_DIM)]
    return vec


@pytest.fixture(autouse=True)
def mock_storage(monkeypatch):
    store: dict[str, bytes] = {}

    async def upload(key: str, body: bytes, content_type: str) -> None:
        store[key] = body

    async def read_bytes(key: str) -> bytes:
        if key not in store:
            raise KeyError(key)
        return store[key]

    async def delete(key: str) -> None:
        store.pop(key, None)

    monkeypatch.setattr(storage_module.storage, "upload", upload)
    monkeypatch.setattr(storage_module.storage, "read_bytes", read_bytes)
    monkeypatch.setattr(storage_module.storage, "delete", delete)
    monkeypatch.setattr(storage_module.storage, "_store", store, raising=False)


async def _import_book(client: AsyncClient, token: str, pdf: bytes) -> int:
    resp = await client.post(
        f"{API}/books",
        headers=_auth(token),
        files={"file": ("rag-book.pdf", pdf, "application/pdf")},
        data={"title": "RAG Test Book"},
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


@pytest.mark.asyncio
async def test_activate_enqueues_outbox_without_indexing(client: AsyncClient):
    _, token = await _token(client)
    pdf = _make_text_pdf(
        [
            "Paragraph about pyramids and the Nile river.\n\nMore history text.",
            "Second page with temples and pharaohs.",
        ]
    )
    book_id = await _import_book(client, token, pdf)

    with patch(
        "app.workers.rag_worker.process_rag_event",
        new_callable=AsyncMock,
    ) as mocked:
        resp = await client.post(
            f"{API}/books/{book_id}/rag/activate",
            headers=_auth(token),
        )
        assert resp.status_code == 202, resp.text
        body = resp.json()
        assert body["book_id"] == book_id
        assert body["status"] == RagStatus.PENDING.value
        assert "document_id" in body
        # Request path must not run the heavy worker.
        mocked.assert_not_called()

    async with AsyncSessionLocal() as db:
        doc = await rag_crud.get_document_by_book(db, book_id)
        assert doc is not None
        assert doc.status == RagStatus.PENDING.value
        events = (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == doc.id)
            )
        ).scalars().all()
        assert len(events) == 1
        assert events[0].event_type == OutboxEventType.RAG_INDEX_REQUESTED.value
        assert events[0].status == OutboxStatus.PENDING.value


@pytest.mark.asyncio
async def test_status_and_owner_isolation(client: AsyncClient):
    _, token_a = await _token(client)
    _, token_b = await _token(client)
    pdf = _make_text_pdf(["Owner isolation page one."])
    book_id = await _import_book(client, token_a, pdf)

    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token_a)
    )
    assert act.status_code == 202

    status_a = await client.get(
        f"{API}/books/{book_id}/rag/status", headers=_auth(token_a)
    )
    assert status_a.status_code == 200
    assert status_a.json()["status"] == RagStatus.PENDING.value
    assert status_a.json()["progress"] == 0

    status_b = await client.get(
        f"{API}/books/{book_id}/rag/status", headers=_auth(token_b)
    )
    assert status_b.status_code == 404

    query_b = await client.post(
        f"{API}/books/{book_id}/rag/query",
        headers=_auth(token_b),
        json={"question": "What about the Nile?"},
    )
    assert query_b.status_code == 404


@pytest.mark.asyncio
async def test_query_rejects_non_ready_book(client: AsyncClient):
    _, token = await _token(client)
    pdf = _make_text_pdf(["Pending index content about astronomy."])
    book_id = await _import_book(client, token, pdf)
    await client.post(f"{API}/books/{book_id}/rag/activate", headers=_auth(token))

    resp = await client.post(
        f"{API}/books/{book_id}/rag/query",
        headers=_auth(token),
        json={"question": "What is this book about?"},
    )
    assert resp.status_code == 409
    assert "não está pronto" in resp.json()["detail"].lower() or "status" in resp.json()[
        "detail"
    ].lower()


@pytest.mark.asyncio
async def test_worker_indexes_and_query_returns_sources(client: AsyncClient):
    _, token = await _token(client)
    pdf = _make_text_pdf(
        [
            "The Nile river was essential to ancient Egyptian agriculture.",
            "Pyramids were tombs for pharaohs built in Giza.",
            "Anubis is the jackal-headed god of mummification and the afterlife.",
        ]
    )
    book_id = await _import_book(client, token, pdf)

    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    assert act.status_code == 202
    document_id = uuid.UUID(act.json()["document_id"])

    # Fake embeddings: similar seeds for related content; query uses close seed.
    async def fake_embed_texts(texts, **kwargs):
        return [_fake_embedding(0.2 + i * 0.01) for i, _ in enumerate(texts)]

    async def fake_embed_query(question, **kwargs):
        return _fake_embedding(0.21)

    async def fake_answer(*, question: str, context: str) -> str:
        assert "Nile" in context or "Pyramids" in context or "Anubis" in context
        return "O Nilo era essencial para a agricultura egípcia. [Fonte 1]"

    with (
        patch(
            "app.services.gemini_embeddings.embed_texts_with_retry",
            side_effect=fake_embed_texts,
        ),
        patch(
            "app.services.gemini_embeddings.configured",
            return_value=True,
        ),
        patch(
            "app.services.gemini_embeddings.embed_query",
            side_effect=fake_embed_query,
        ),
        patch(
            "app.services.rag_service.generate_rag_answer",
            side_effect=fake_answer,
        ),
    ):
        # Drain unrelated outbox rows so process_one claims our RAG event.
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(OutboxEvent)
                .where(
                    OutboxEvent.aggregate_id != document_id,
                    OutboxEvent.status.in_(
                        [OutboxStatus.PENDING.value, OutboxStatus.PROCESSING.value]
                    ),
                )
                .values(
                    status=OutboxStatus.DONE.value,
                    processed_at=datetime.now(UTC),
                )
            )
            await db.commit()

        # Real shipped worker entrypoint: claim_next + handler.
        processed = await process_one()
        assert processed is True

        status = await client.get(
            f"{API}/books/{book_id}/rag/status", headers=_auth(token)
        )
        assert status.status_code == 200, status.text
        body = status.json()
        assert body["status"] == RagStatus.COMPLETED.value, body
        assert body["chunk_count"] >= 1
        assert body["progress"] == 100

        q = await client.post(
            f"{API}/books/{book_id}/rag/query",
            headers=_auth(token),
            json={"question": "Qual o papel do Nilo?", "top_k": 3},
        )
        assert q.status_code == 200, q.text
        payload = q.json()
        assert payload["book_id"] == book_id
        assert "Nilo" in payload["answer"] or "agricultura" in payload["answer"].lower()
        assert len(payload["sources"]) >= 1
        src = payload["sources"][0]
        assert "page_start" in src
        assert src["page_start"] is not None
        assert src["excerpt"]
        assert isinstance(src["chunk_index"], int)

    async with AsyncSessionLocal() as db:
        events = (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == document_id)
            )
        ).scalars().all()
        assert any(e.status == OutboxStatus.DONE.value for e in events)


@pytest.mark.asyncio
async def test_reprocess_resets_and_enqueues(client: AsyncClient):
    _, token = await _token(client)
    pdf = _make_text_pdf(["Reprocess page content for RAG."])
    book_id = await _import_book(client, token, pdf)

    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    document_id = uuid.UUID(act.json()["document_id"])

    # Mark completed with a fake chunk so reprocess has something to clear.
    async with AsyncSessionLocal() as db:
        doc = await rag_crud.get_document_by_id(db, document_id)
        assert doc is not None
        await rag_crud.mark_completed(db, doc, chunk_count=1)
        await rag_crud.insert_chunks(
            db,
            document_id=document_id,
            book_id=book_id,
            rows=[
                {
                    "chunk_index": 0,
                    "title": "t",
                    "content": "old chunk",
                    "page_start": 1,
                    "page_end": 1,
                    "embedding": _fake_embedding(0.5),
                }
            ],
        )
        await db.commit()

    resp = await client.post(
        f"{API}/books/{book_id}/rag/reprocess", headers=_auth(token)
    )
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == RagStatus.PENDING.value

    async with AsyncSessionLocal() as db:
        doc = await rag_crud.get_document_by_id(db, document_id)
        assert doc is not None
        assert doc.status == RagStatus.PENDING.value
        assert doc.chunk_count == 0
        count = await rag_crud.count_chunks_for_book(db, book_id)
        assert count == 0
        events = (
            await db.execute(
                select(OutboxEvent).where(
                    OutboxEvent.aggregate_id == document_id,
                    OutboxEvent.event_type
                    == OutboxEventType.RAG_REINDEX_REQUESTED.value,
                )
            )
        ).scalars().all()
        assert len(events) >= 1
        assert events[-1].status == OutboxStatus.PENDING.value


@pytest.mark.asyncio
async def test_pgvector_hnsw_and_similarity_insert(client: AsyncClient):
    """Prove HNSW index exists and similarity search works on real vectors."""
    async with AsyncSessionLocal() as db:
        assert await rag_crud.hnsw_index_exists(db) is True

        # Lightweight insert/search without full HTTP book import.
        from app.models.book import Book
        from app.models.user import User
        from app.core.security import hash_password

        email = _email()
        user = User(
            email=email,
            hashed_password=hash_password(PASSWORD),
            full_name="Vec",
            is_active=True,
        )
        db.add(user)
        await db.flush()

        book = Book(
            user_id=user.id,
            title="Vec Book",
            author=None,
            file_format="pdf",
            content_type="application/pdf",
            file_size=10,
            original_filename="v.pdf",
            object_key=f"users/{user.id}/books/{uuid.uuid4().hex}.pdf",
            page_count=1,
        )
        db.add(book)
        await db.flush()

        doc = await rag_crud.create_document(
            db, book_id=book.id, owner_id=user.id, page_count=1
        )
        target = _fake_embedding(0.3)
        other = _fake_embedding(0.9)
        await rag_crud.insert_chunks(
            db,
            document_id=doc.id,
            book_id=book.id,
            rows=[
                {
                    "chunk_index": 0,
                    "title": "near",
                    "content": "near text about cats",
                    "page_start": 2,
                    "page_end": 2,
                    "embedding": target,
                },
                {
                    "chunk_index": 1,
                    "title": "far",
                    "content": "far text about quantum physics",
                    "page_start": 9,
                    "page_end": 9,
                    "embedding": other,
                },
            ],
        )
        await db.commit()

        hits = await rag_crud.similarity_search(
            db, book_id=book.id, query_embedding=target, top_k=1
        )
        assert len(hits) == 1
        chunk, score = hits[0]
        assert chunk.page_start == 2
        assert "cats" in chunk.content
        assert score is not None


@pytest.mark.asyncio
async def test_worker_empty_pdf_marks_failed_non_retryable(client: AsyncClient):
    _, token = await _token(client)
    # Scanned-like empty page (no text)
    doc = pymupdf.open()
    doc.new_page()
    pdf = doc.tobytes()
    doc.close()
    book_id = await _import_book(client, token, pdf)

    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    document_id = uuid.UUID(act.json()["document_id"])

    with patch("app.services.gemini_embeddings.configured", return_value=True):
        async with AsyncSessionLocal() as db:
            event = (
                await db.execute(
                    select(OutboxEvent).where(OutboxEvent.aggregate_id == document_id)
                )
            ).scalar_one()
            await process_rag_event(db, event)
            await db.commit()

            rag_doc = await rag_crud.get_document_by_id(db, document_id)
            assert rag_doc is not None
            assert rag_doc.status == RagStatus.FAILED.value
            assert rag_doc.error_code == "empty_text"


@pytest.mark.asyncio
async def test_unauthorized_activate_rejected(client: AsyncClient):
    resp = await client.post(f"{API}/books/1/rag/activate")
    assert resp.status_code == 401


async def _drain_outbox_except(document_id: uuid.UUID | None = None) -> None:
    async with AsyncSessionLocal() as db:
        stmt = update(OutboxEvent).where(
            OutboxEvent.status.in_(
                [OutboxStatus.PENDING.value, OutboxStatus.PROCESSING.value]
            )
        )
        if document_id is not None:
            stmt = stmt.where(OutboxEvent.aggregate_id != document_id)
        await db.execute(
            stmt.values(
                status=OutboxStatus.DONE.value,
                processed_at=datetime.now(UTC),
            )
        )
        await db.commit()


@pytest.mark.asyncio
async def test_claim_next_uses_rag_lease_seconds(client: AsyncClient):
    """RAG events must lease with RAG_OUTBOX_LEASE_SECONDS, not conversion 300s."""
    _, token = await _token(client)
    pdf = _make_text_pdf(["Lease seconds content for claim."])
    book_id = await _import_book(client, token, pdf)
    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    document_id = uuid.UUID(act.json()["document_id"])
    await _drain_outbox_except(document_id)

    async with AsyncSessionLocal() as db:
        before = datetime.now(UTC)
        event = await outbox_crud.claim_next(
            db,
            worker_id="lease-test",
            event_types=[
                OutboxEventType.RAG_INDEX_REQUESTED,
                OutboxEventType.RAG_REINDEX_REQUESTED,
            ],
        )
        assert event is not None
        assert event.aggregate_id == document_id
        assert event.locked_until is not None
        lease = event.locked_until - before
        # RAG lease is 600s; conversion is 300s — require clearly > 300.
        assert lease >= timedelta(seconds=settings.RAG_OUTBOX_LEASE_SECONDS - 5)
        assert settings.RAG_OUTBOX_LEASE_SECONDS > settings.PDF_CONVERSION_OUTBOX_LEASE_SECONDS
        assert outbox_crud.lease_seconds_for_event_type(
            OutboxEventType.RAG_INDEX_REQUESTED.value
        ) == settings.RAG_OUTBOX_LEASE_SECONDS
        assert outbox_crud.lease_seconds_for_event_type(
            OutboxEventType.PDF_CONVERSION_REQUESTED.value
        ) == settings.PDF_CONVERSION_OUTBOX_LEASE_SECONDS
        await db.rollback()


@pytest.mark.asyncio
async def test_process_one_retry_schedules_next_retry_keeps_doc_processing(
    client: AsyncClient,
):
    """Retryable embed failure: outbox pending+next_retry_at; doc stays processing."""
    await engine.dispose()
    _, token = await _token(client)
    pdf = _make_text_pdf(["Retry path text about embedding failures."])
    book_id = await _import_book(client, token, pdf)
    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    document_id = uuid.UUID(act.json()["document_id"])
    await _drain_outbox_except(document_id)

    with (
        patch("app.services.gemini_embeddings.configured", return_value=True),
        patch(
            "app.services.gemini_embeddings.embed_texts_with_retry",
            side_effect=EmbeddingError("transient gemini outage"),
        ),
    ):
        processed = await process_one()
        assert processed is True

    async with AsyncSessionLocal() as db:
        event = (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == document_id)
            )
        ).scalar_one()
        assert event.status == OutboxStatus.PENDING.value
        assert event.next_retry_at is not None
        assert event.next_retry_at > datetime.now(UTC)
        assert event.attempts == 1
        assert event.attempts < event.max_attempts
        assert "transient" in (event.error_message or "").lower() or "gemini" in (
            event.error_message or ""
        ).lower()

        doc = await rag_crud.get_document_by_id(db, document_id)
        assert doc is not None
        # Lifecycle: still processing while retries remain (not terminal failed).
        assert doc.status == RagStatus.PROCESSING.value
        assert doc.error_code == "embedding_failed"


@pytest.mark.asyncio
async def test_process_one_exhausts_retries_marks_doc_failed(client: AsyncClient):
    """When outbox attempts hit max, document becomes terminal failed."""
    await engine.dispose()
    _, token = await _token(client)
    pdf = _make_text_pdf(["Exhaust retries content."])
    book_id = await _import_book(client, token, pdf)
    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    document_id = uuid.UUID(act.json()["document_id"])
    await _drain_outbox_except(document_id)

    # Force max_attempts=1 so first failure is terminal.
    async with AsyncSessionLocal() as db:
        event = (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == document_id)
            )
        ).scalar_one()
        event.max_attempts = 1
        await db.commit()

    with (
        patch("app.services.gemini_embeddings.configured", return_value=True),
        patch(
            "app.services.gemini_embeddings.embed_texts_with_retry",
            side_effect=EmbeddingError("still down"),
        ),
    ):
        processed = await process_one()
        assert processed is True

    async with AsyncSessionLocal() as db:
        event = (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.aggregate_id == document_id)
            )
        ).scalar_one()
        assert event.status == OutboxStatus.FAILED.value
        assert event.attempts == 1
        assert event.next_retry_at is None or event.processed_at is not None

        doc = await rag_crud.get_document_by_id(db, document_id)
        assert doc is not None
        assert doc.status == RagStatus.FAILED.value
        assert doc.error_code == "embedding_failed"


@pytest.mark.asyncio
async def test_completed_index_request_is_noop(client: AsyncClient):
    """Duplicate RagIndexRequested on a completed document skips re-embed."""
    _, token = await _token(client)
    pdf = _make_text_pdf(["Already indexed Nile text."])
    book_id = await _import_book(client, token, pdf)
    act = await client.post(
        f"{API}/books/{book_id}/rag/activate", headers=_auth(token)
    )
    document_id = uuid.UUID(act.json()["document_id"])

    async def fake_embed_texts(texts, **kwargs):
        return [_fake_embedding(0.15) for _ in texts]

    with (
        patch("app.services.gemini_embeddings.configured", return_value=True),
        patch(
            "app.services.gemini_embeddings.embed_texts_with_retry",
            side_effect=fake_embed_texts,
        ) as embed_mock,
    ):
        async with AsyncSessionLocal() as db:
            event = (
                await db.execute(
                    select(OutboxEvent).where(OutboxEvent.aggregate_id == document_id)
                )
            ).scalar_one()
            await process_rag_event(db, event)
            await db.commit()
            assert embed_mock.await_count >= 1
            first_calls = embed_mock.await_count

            doc = await rag_crud.get_document_by_id(db, document_id)
            assert doc is not None
            assert doc.status == RagStatus.COMPLETED.value
            chunk_count = doc.chunk_count

            # Simulate a duplicate index event while still completed.
            dup = OutboxEvent(
                aggregate_id=document_id,
                event_type=OutboxEventType.RAG_INDEX_REQUESTED.value,
                payload_json={},
                status=OutboxStatus.PROCESSING.value,
                attempts=1,
                max_attempts=5,
            )
            db.add(dup)
            await db.flush()
            await process_rag_event(db, dup)
            await db.commit()

            # No additional embedding work.
            assert embed_mock.await_count == first_calls
            doc2 = await rag_crud.get_document_by_id(db, document_id)
            assert doc2 is not None
            assert doc2.status == RagStatus.COMPLETED.value
            assert doc2.chunk_count == chunk_count
