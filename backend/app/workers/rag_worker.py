"""Idempotent RAG index pipeline with incremental embed + resume."""

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
    """Extract → chunk → embed (incremental) → store; resume after retries."""
    document_id: uuid.UUID = event.aggregate_id
    doc = await rag_crud.get_document_by_id(db, document_id)
    if doc is None:
        raise RagWorkerError(
            "RAG document not found",
            error_code=RagErrorCode.INDEXING_FAILED.value,
            retryable=False,
        )

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

        total = len(specs)
        await rag_crud.mark_progress(db, doc, progress=35, chunk_count=total)
        await db.commit()

        # Resume: keep contiguous chunks already stored; wipe if inconsistent.
        stored = await rag_crud.count_chunks_for_document(db, doc.id)
        max_idx = await rag_crud.max_chunk_index_for_document(db, doc.id)
        resume_from = 0
        if stored > 0 and max_idx is not None:
            contiguous = stored == max_idx + 1 and max_idx < total
            if contiguous:
                resume_from = stored
                logger.info(
                    "RAG resume document=%s from chunk %s/%s",
                    doc.id,
                    resume_from,
                    total,
                )
            else:
                logger.info(
                    "RAG wipe stale chunks document=%s stored=%s max_idx=%s total=%s",
                    doc.id,
                    stored,
                    max_idx,
                    total,
                )
                await rag_crud.delete_chunks_for_document(db, doc.id)
                await db.commit()
                resume_from = 0
        elif stored > 0:
            await rag_crud.delete_chunks_for_document(db, doc.id)
            await db.commit()
            resume_from = 0

        if resume_from >= total:
            await rag_crud.mark_completed(db, doc, chunk_count=total)
            await db.commit()
            return

        # True multi-content batch size for gemini-embedding-001; 1 for -2.
        batch = max(1, settings.RAG_EMBED_BATCH_SIZE)
        model = (settings.GEMINI_EMBEDDING_MODEL or "").lower()
        if "embedding-2" in model:
            batch = 8  # smaller windows when forced to per-item inside embed_texts

        for start in range(resume_from, total, batch):
            end = min(start + batch, total)
            window = specs[start:end]
            texts = [s.content for s in window]
            try:
                vectors = await gemini_embeddings.embed_texts_with_retry(
                    texts,
                    task_type="RETRIEVAL_DOCUMENT",
                )
            except gemini_embeddings.EmbeddingError as exc:
                raise RagWorkerError(
                    str(exc),
                    error_code=RagErrorCode.EMBEDDING_FAILED.value,
                    retryable=True,
                ) from exc

            if len(vectors) != len(window):
                raise RagWorkerError(
                    f"embedding count mismatch: {len(vectors)} vs {len(window)}",
                    error_code=RagErrorCode.EMBEDDING_FAILED.value,
                    retryable=True,
                )

            rows = [
                {
                    "chunk_index": spec.chunk_index,
                    "title": spec.title,
                    "content": spec.content,
                    "page_start": spec.page_start,
                    "page_end": spec.page_end,
                    "embedding": vectors[i],
                }
                for i, spec in enumerate(window)
            ]
            # Persist immediately so retries resume (do not wipe earlier rows).
            await rag_crud.insert_chunks(
                db,
                document_id=doc.id,
                book_id=doc.book_id,
                rows=rows,
            )
            progress = 35 + int(60 * end / total)
            await rag_crud.mark_progress(
                db, doc, progress=min(95, progress), chunk_count=total
            )
            # Clear transient error once progress resumes.
            doc.error_code = None
            doc.error_message = None
            await db.commit()
            logger.info(
                "RAG embedded %s/%s document=%s book=%s",
                end,
                total,
                doc.id,
                doc.book_id,
            )

        await rag_crud.mark_completed(db, doc, chunk_count=total)
        await db.commit()
        logger.info(
            "RAG index completed document=%s book=%s chunks=%s",
            doc.id,
            doc.book_id,
            total,
        )
    except RagWorkerError as exc:
        await db.rollback()
        fresh = await rag_crud.get_document_by_id(db, document_id)
        if fresh is None:
            if exc.retryable:
                raise
            return

        if not exc.retryable:
            await rag_crud.mark_failed(
                db,
                fresh,
                error_code=exc.error_code,
                message=str(exc),
            )
            await db.commit()
            return

        fresh.status = RagStatus.PROCESSING.value
        fresh.error_code = exc.error_code
        fresh.error_message = str(exc)[:2000]
        await db.flush()
        await db.commit()
        raise
    except Exception:
        logger.exception("RAG worker unexpected error for %s", document_id)
        await db.rollback()
        raise
