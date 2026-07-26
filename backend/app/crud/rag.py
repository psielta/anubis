"""Persistence helpers for RAG documents and vector chunks."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.rag import RAG_EMBEDDING_DIM, RagChunk, RagDocument, RagStatus


async def get_document_by_book(
    db: AsyncSession, book_id: int
) -> RagDocument | None:
    return await db.scalar(
        select(RagDocument).where(RagDocument.book_id == book_id)
    )


async def get_document_for_owner(
    db: AsyncSession, *, owner_id: int, book_id: int
) -> RagDocument | None:
    return await db.scalar(
        select(RagDocument).where(
            RagDocument.book_id == book_id,
            RagDocument.owner_id == owner_id,
        )
    )


async def get_document_by_id(
    db: AsyncSession, document_id: uuid.UUID
) -> RagDocument | None:
    return await db.get(RagDocument, document_id)


async def create_document(
    db: AsyncSession,
    *,
    book_id: int,
    owner_id: int,
    page_count: int | None = None,
) -> RagDocument:
    doc = RagDocument(
        book_id=book_id,
        owner_id=owner_id,
        status=RagStatus.PENDING.value,
        progress=0,
        page_count=page_count,
    )
    db.add(doc)
    await db.flush()
    return doc


async def reset_for_reprocess(
    db: AsyncSession,
    doc: RagDocument,
    *,
    page_count: int | None = None,
) -> RagDocument:
    """Clear chunks and put document back to pending for re-indexing."""
    await delete_chunks_for_document(db, doc.id)
    doc.status = RagStatus.PENDING.value
    doc.progress = 0
    doc.chunk_count = 0
    doc.error_code = None
    doc.error_message = None
    doc.started_at = None
    doc.completed_at = None
    if page_count is not None:
        doc.page_count = page_count
    await db.flush()
    return doc


async def mark_processing(db: AsyncSession, doc: RagDocument) -> None:
    doc.status = RagStatus.PROCESSING.value
    doc.progress = max(doc.progress, 5)
    if doc.started_at is None:
        doc.started_at = datetime.now(UTC)
    doc.error_code = None
    doc.error_message = None
    await db.flush()


async def mark_progress(
    db: AsyncSession,
    doc: RagDocument,
    *,
    progress: int,
    chunk_count: int | None = None,
) -> None:
    doc.progress = max(0, min(100, progress))
    if chunk_count is not None:
        doc.chunk_count = chunk_count
    await db.flush()


async def mark_completed(
    db: AsyncSession, doc: RagDocument, *, chunk_count: int
) -> None:
    doc.status = RagStatus.COMPLETED.value
    doc.progress = 100
    doc.chunk_count = chunk_count
    doc.completed_at = datetime.now(UTC)
    doc.error_code = None
    doc.error_message = None
    await db.flush()


async def mark_failed(
    db: AsyncSession,
    doc: RagDocument,
    *,
    error_code: str,
    message: str,
) -> None:
    doc.status = RagStatus.FAILED.value
    doc.error_code = error_code
    doc.error_message = message[:2000]
    doc.completed_at = datetime.now(UTC)
    await db.flush()


async def delete_chunks_for_document(
    db: AsyncSession, document_id: uuid.UUID
) -> None:
    await db.execute(
        delete(RagChunk).where(RagChunk.document_id == document_id)
    )
    await db.flush()


def _pg_safe_text(value: str | None) -> str:
    """Postgres UTF-8 text rejects NUL (0x00) common in some PDF extractions."""
    if not value:
        return ""
    return value.replace("\x00", "")


async def insert_chunks(
    db: AsyncSession,
    *,
    document_id: uuid.UUID,
    book_id: int,
    rows: list[dict],
) -> int:
    """Bulk-insert chunk rows. Each row needs chunk_index, content, embedding, etc."""
    for row in rows:
        emb = row["embedding"]
        if len(emb) != RAG_EMBEDDING_DIM:
            raise ValueError(
                f"embedding dim {len(emb)} != expected {RAG_EMBEDDING_DIM}"
            )
        db.add(
            RagChunk(
                document_id=document_id,
                book_id=book_id,
                chunk_index=row["chunk_index"],
                title=_pg_safe_text(row.get("title") or ""),
                content=_pg_safe_text(row["content"]),
                page_start=row.get("page_start"),
                page_end=row.get("page_end"),
                embedding=emb,
            )
        )
    await db.flush()
    return len(rows)


async def similarity_search(
    db: AsyncSession,
    *,
    book_id: int,
    query_embedding: list[float],
    top_k: int = 5,
) -> list[tuple[RagChunk, float]]:
    """Return top-k chunks for book by cosine distance (lower distance = closer)."""
    if len(query_embedding) != RAG_EMBEDDING_DIM:
        raise ValueError(
            f"query embedding dim {len(query_embedding)} != {RAG_EMBEDDING_DIM}"
        )

    # Cosine distance operator <=> ; convert to similarity score 1 - distance.
    distance = RagChunk.embedding.cosine_distance(query_embedding)
    stmt = (
        select(RagChunk, distance.label("distance"))
        .where(RagChunk.book_id == book_id)
        .order_by(distance)
        .limit(top_k)
    )
    result = await db.execute(stmt)
    rows = result.all()
    out: list[tuple[RagChunk, float]] = []
    for chunk, dist in rows:
        score = 1.0 - float(dist) if dist is not None else None
        out.append((chunk, score if score is not None else 0.0))
    return out


async def count_chunks_for_book(db: AsyncSession, book_id: int) -> int:
    result = await db.execute(
        select(RagChunk.id).where(RagChunk.book_id == book_id)
    )
    return len(result.all())


async def count_chunks_for_document(
    db: AsyncSession, document_id: uuid.UUID
) -> int:
    from sqlalchemy import func

    result = await db.execute(
        select(func.count())
        .select_from(RagChunk)
        .where(RagChunk.document_id == document_id)
    )
    return int(result.scalar_one())


async def max_chunk_index_for_document(
    db: AsyncSession, document_id: uuid.UUID
) -> int | None:
    from sqlalchemy import func

    result = await db.execute(
        select(func.max(RagChunk.chunk_index)).where(
            RagChunk.document_id == document_id
        )
    )
    val = result.scalar_one()
    return int(val) if val is not None else None


async def hnsw_index_exists(db: AsyncSession) -> bool:
    """Structural check used by tests: HNSW index on rag_chunks.embedding."""
    result = await db.execute(
        text(
            """
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE tablename = 'rag_chunks'
              AND indexdef ILIKE '%hnsw%'
            """
        )
    )
    return result.first() is not None
