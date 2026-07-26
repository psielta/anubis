"""Idempotent RAG index pipeline invoked from the outbox worker."""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.crud import book as book_crud
from app.crud import rag as rag_crud
from app.models.outbox import OutboxEvent, OutboxEventType
from app.models.rag import RagErrorCode, RagStatus
from app.services import gemini_embeddings, pdf_text_extract, rag_chunking
from app.services.storage import storage

logger = logging.getLogger(__name__)


class RagWorkerError(Exception):
    def __init__(self, message: str, *, error_code: str, retryable: bool = True):
        super().__init__(message)
        self.error_code = error_code
        self.retryable = retryable


async def process_rag_event(db: AsyncSession, event: OutboxEvent) -> None:
    """Extract → chunk → embed → store vectors; update document status.

    Non-retryable failures mark the document ``failed`` and return.
    Retryable failures leave the document in ``processing`` and raise
    ``RagWorkerError`` so the outbox poller can schedule backoff.
    """
    document_id: uuid.UUID = event.aggregate_id
    doc = await rag_crud.get_document_by_id(db, document_id)
    if doc is None:
        raise RagWorkerError(
            "RAG document not found",
            error_code=RagErrorCode.INDEXING_FAILED.value,
            retryable=False,
        )

    # Duplicate activate while already completed: no-op.
    # Reprocess always resets status to pending before enqueueing.
    if (
        doc.status == RagStatus.COMPLETED.value
        and event.event_type == OutboxEventType.RAG_INDEX_REQUESTED.value
    ):
        logger.info(
            "RAG document %s already completed; skipping re-index", document_id
        )
        return

    book = await book_crud.get_for_user(db, doc.owner_id, doc.book_id)
    if book is None:
        await rag_crud.mark_failed(
            db,
            doc,
            error_code=RagErrorCode.INDEXING_FAILED.value,
            message="Livro não encontrado para o dono do documento RAG",
        )
        await db.commit()
        return

    await rag_crud.mark_processing(db, doc)
    await db.commit()

    try:
        if not gemini_embeddings.configured():
            raise RagWorkerError(
                "GEMINI_API_KEY is not configured",
                error_code=RagErrorCode.NOT_CONFIGURED.value,
                retryable=False,
            )

        pdf_bytes = await storage.read_bytes(book.object_key)
        try:
            extracted = pdf_text_extract.extract_pages(pdf_bytes)
        except pdf_text_extract.PdfTextExtractError as exc:
            raise RagWorkerError(
                str(exc),
                error_code=RagErrorCode.INVALID_PDF.value,
                retryable=False,
            ) from exc

        doc.page_count = len(extracted.pages)
        if not extracted.full_text.strip():
            raise RagWorkerError(
                "PDF sem texto extraível (possível scan sem OCR)",
                error_code=RagErrorCode.EMPTY_TEXT.value,
                retryable=False,
            )

        await rag_crud.mark_progress(db, doc, progress=20)
        await db.commit()

        specs = rag_chunking.chunk_pages_text(
            extracted.full_text,
            extracted.page_offsets,
            max_chars=settings.RAG_CHUNK_MAX_CHARS,
            overlap=settings.RAG_CHUNK_OVERLAP_CHARS,
        )
        if not specs:
            raise RagWorkerError(
                "Nenhum chunk gerado a partir do texto do PDF",
                error_code=RagErrorCode.EMPTY_TEXT.value,
                retryable=False,
            )

        await rag_crud.mark_progress(db, doc, progress=35, chunk_count=len(specs))
        await db.commit()

        # Clear previous vectors before inserting new ones (reprocess-safe).
        await rag_crud.delete_chunks_for_document(db, doc.id)
        await db.commit()

        texts = [s.content for s in specs]
        batch = max(1, settings.RAG_EMBED_BATCH_SIZE)
        all_rows: list[dict] = []
        for start in range(0, len(texts), batch):
            end = min(start + batch, len(texts))
            try:
                vectors = await gemini_embeddings.embed_texts_with_retry(
                    texts[start:end],
                    task_type="RETRIEVAL_DOCUMENT",
                )
            except gemini_embeddings.EmbeddingError as exc:
                raise RagWorkerError(
                    str(exc),
                    error_code=RagErrorCode.EMBEDDING_FAILED.value,
                    retryable=True,
                ) from exc

            for i, spec in enumerate(specs[start:end]):
                all_rows.append(
                    {
                        "chunk_index": spec.chunk_index,
                        "title": spec.title,
                        "content": spec.content,
                        "page_start": spec.page_start,
                        "page_end": spec.page_end,
                        "embedding": vectors[i],
                    }
                )

            progress = 35 + int(55 * end / len(texts))
            await rag_crud.mark_progress(
                db, doc, progress=progress, chunk_count=len(specs)
            )
            await db.commit()

        # Insert in sub-batches to keep transactions bounded.
        insert_batch = 50
        for start in range(0, len(all_rows), insert_batch):
            await rag_crud.insert_chunks(
                db,
                document_id=doc.id,
                book_id=doc.book_id,
                rows=all_rows[start : start + insert_batch],
            )
            await db.commit()

        await rag_crud.mark_completed(db, doc, chunk_count=len(specs))
        await db.commit()
        logger.info(
            "RAG index completed document=%s book=%s chunks=%s",
            doc.id,
            doc.book_id,
            len(specs),
        )
    except RagWorkerError as exc:
        await db.rollback()
        fresh = await rag_crud.get_document_by_id(db, document_id)
        if fresh is None:
            if exc.retryable:
                raise
            return

        if not exc.retryable:
            # Terminal document failure; outbox marks done/failed without retry.
            await rag_crud.mark_failed(
                db,
                fresh,
                error_code=exc.error_code,
                message=str(exc),
            )
            await db.commit()
            return

        # Retryable: keep processing lifecycle; record last error for status.
        # Do NOT mark document failed — outbox still has retries left.
        fresh.status = RagStatus.PROCESSING.value
        fresh.error_code = exc.error_code
        fresh.error_message = str(exc)[:2000]
        await db.flush()
        await db.commit()
        raise
    except Exception:
        logger.exception("RAG worker unexpected error for %s", document_id)
        await db.rollback()
        # Leave document processing; outbox handler schedules retry or terminal fail.
        raise
