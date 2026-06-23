import uuid

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pdf_conversion import (
    PdfConversionChunk,
    PdfConversionJob,
    PdfConversionStatus,
)


async def create_job(
    db: AsyncSession,
    *,
    owner_id: int,
    tenant_id: int,
    original_filename: str,
    input_file_path: str,
) -> PdfConversionJob:
    job = PdfConversionJob(
        owner_id=owner_id,
        tenant_id=tenant_id,
        original_filename=original_filename,
        input_file_path=input_file_path,
        status=PdfConversionStatus.PENDING.value,
        progress=0,
    )
    db.add(job)
    await db.flush()
    return job


async def list_for_owner(
    db: AsyncSession,
    owner_id: int,
    *,
    limit: int = 50,
) -> list[PdfConversionJob]:
    stmt = (
        select(PdfConversionJob)
        .where(PdfConversionJob.owner_id == owner_id)
        .order_by(PdfConversionJob.created_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_for_owner(
    db: AsyncSession, owner_id: int, job_id: uuid.UUID
) -> PdfConversionJob | None:
    stmt = select(PdfConversionJob).where(
        PdfConversionJob.id == job_id,
        PdfConversionJob.owner_id == owner_id,
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_by_id(db: AsyncSession, job_id: uuid.UUID) -> PdfConversionJob | None:
    result = await db.execute(
        select(PdfConversionJob).where(PdfConversionJob.id == job_id)
    )
    return result.scalar_one_or_none()


async def refresh_job(db: AsyncSession, job: PdfConversionJob) -> PdfConversionJob:
    await db.refresh(job)
    return job


async def delete_chunks_for_job(db: AsyncSession, job_id: uuid.UUID) -> None:
    await db.execute(
        delete(PdfConversionChunk).where(PdfConversionChunk.job_id == job_id)
    )
    await db.flush()


async def list_chunk_summaries(
    db: AsyncSession, job_id: uuid.UUID
) -> list[PdfConversionChunk]:
    stmt = (
        select(PdfConversionChunk)
        .where(PdfConversionChunk.job_id == job_id)
        .order_by(PdfConversionChunk.chunk_index)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_chunk(
    db: AsyncSession, job_id: uuid.UUID, chunk_index: int
) -> PdfConversionChunk | None:
    stmt = select(PdfConversionChunk).where(
        PdfConversionChunk.job_id == job_id,
        PdfConversionChunk.chunk_index == chunk_index,
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def bulk_create_chunks(
    db: AsyncSession, chunks: list[PdfConversionChunk]
) -> None:
    db.add_all(chunks)
    await db.flush()
    for chunk in chunks:
        await db.execute(
            text(
                "UPDATE pdf_conversion_chunks SET search_tsv = "
                "to_tsvector('portuguese', coalesce(title, '') || ' ' || content_markdown) "
                "WHERE id = :id"
            ),
            {"id": chunk.id},
        )
    await db.flush()


async def search_chunks(
    db: AsyncSession,
    job_id: uuid.UUID,
    query: str,
    *,
    limit: int = 20,
) -> list[tuple[PdfConversionChunk, str, float]]:
    stmt = text(
        """
        SELECT
            c.id,
            c.chunk_index,
            c.title,
            c.page_start,
            c.page_end,
            c.content_markdown,
            c.content_length,
            ts_headline(
                'portuguese',
                c.content_markdown,
                plainto_tsquery('portuguese', :q),
                'MaxFragments=2, MaxWords=30, MinWords=10'
            ) AS snippet,
            ts_rank(c.search_tsv, plainto_tsquery('portuguese', :q)) AS rank
        FROM pdf_conversion_chunks c
        WHERE c.job_id = :job_id
          AND c.search_tsv @@ plainto_tsquery('portuguese', :q)
        ORDER BY rank DESC
        LIMIT :lim
        """
    )
    result = await db.execute(
        stmt, {"job_id": job_id, "q": query, "lim": limit}
    )
    rows = result.mappings().all()
    hits: list[tuple[PdfConversionChunk, str, float]] = []
    for row in rows:
        chunk = PdfConversionChunk(
            id=row["id"],
            job_id=job_id,
            chunk_index=row["chunk_index"],
            title=row["title"],
            page_start=row["page_start"],
            page_end=row["page_end"],
            content_markdown=row["content_markdown"],
            content_length=row["content_length"],
        )
        hits.append((chunk, row["snippet"], float(row["rank"])))
    return hits


async def queue_depth(db: AsyncSession) -> int:
    from app.models.outbox import OutboxEvent, OutboxStatus

    stmt = select(func.count()).select_from(OutboxEvent).where(
        OutboxEvent.status == OutboxStatus.PENDING.value
    )
    result = await db.execute(stmt)
    return int(result.scalar_one())