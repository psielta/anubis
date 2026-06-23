"""Idempotent PDF→Markdown conversion stages (invoked from outbox worker)."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.crud import pdf_conversion as job_crud
from app.models.outbox import OutboxEvent
from app.models.pdf_conversion import PdfConversionErrorCode, PdfConversionStatus
from app.services import (
    chunking_service,
    markitdown_service,
    pdf_conversion_service,
    pdf_split_service,
)
from app.services.redis_pubsub_service import redis_pubsub
from app.services.storage import storage

logger = logging.getLogger(__name__)

_seq = 0


def _next_seq() -> int:
    global _seq
    _seq += 1
    return _seq


async def _publish(
    job_id: uuid.UUID,
    *,
    status: str,
    progress: int,
    message: str | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    try:
        await redis_pubsub.publish_event(
            job_id,
            status=status,
            progress=progress,
            message=message,
            error_code=error_code,
            error_message=error_message,
            seq=_next_seq(),
        )
    except Exception:
        logger.exception("Redis publish failed for job %s", job_id)


async def _check_cancel(db: AsyncSession, job_id: uuid.UUID) -> bool:
    job = await job_crud.get_by_id(db, job_id)
    return bool(job and job.cancel_requested)


async def _convert_pages(
    db: AsyncSession, job, pdf_bytes: bytes
) -> tuple[str, list[tuple[int, int]]] | None:
    page_pdfs = await asyncio.to_thread(pdf_split_service.split_pages, pdf_bytes)
    job.page_count = len(page_pdfs)
    await db.commit()

    accumulated: list[str] = []
    offsets: list[tuple[int, int]] = []
    offset = 0

    for idx, page_pdf in enumerate(page_pdfs, start=1):
        if await _check_cancel(db, job.id):
            pdf_conversion_service.mark_canceled(job)
            await db.commit()
            await _publish(
                job.id,
                status=job.status,
                progress=job.progress,
                message="Cancelado",
                error_code=job.error_code,
                error_message=job.error_message,
            )
            return None

        offsets.append((offset, idx))
        md = await asyncio.to_thread(markitdown_service.convert_page, page_pdf)
        if md:
            accumulated.append(md)
            offset += len(md)
            if idx < len(page_pdfs):
                accumulated.append("\n\n")
                offset += 2

        progress = markitdown_service.interpolate_progress(idx, len(page_pdfs))
        job.progress = progress
        await db.commit()
        await _publish(
            job.id,
            status=job.status,
            progress=progress,
            message=f"Página {idx}/{len(page_pdfs)}",
        )

    full_md = "".join(accumulated)
    if not full_md.strip() and job.page_count and job.page_count > 0:
        pdf_conversion_service.mark_failed(
            job,
            error_code=PdfConversionErrorCode.SCANNED_NO_TEXT,
            message="PDF escaneado sem camada de texto detectável",
        )
        await db.commit()
        await _publish(
            job.id,
            status=job.status,
            progress=job.progress,
            error_code=job.error_code,
            error_message=job.error_message,
        )
        return None

    return full_md, offsets


async def process_conversion(db: AsyncSession, event: OutboxEvent) -> None:
    job = await job_crud.get_by_id(db, event.aggregate_id)
    if job is None:
        return

    if job.status in {
        PdfConversionStatus.COMPLETED.value,
        PdfConversionStatus.CANCELED.value,
    }:
        return

    if event.event_type.endswith("CancelRequested"):
        if job.status not in {
            PdfConversionStatus.COMPLETED.value,
            PdfConversionStatus.FAILED.value,
            PdfConversionStatus.CANCELED.value,
        }:
            job.cancel_requested = True
            await db.commit()
        return

    if job.status == PdfConversionStatus.PENDING.value:
        job.status = PdfConversionStatus.PROCESSING.value
        job.started_at = datetime.now(UTC)
        job.progress = 20
        await db.commit()
        await _publish(job.id, status=job.status, progress=20, message="Conversão iniciada")

    full_md: str
    offsets: list[tuple[int, int]]

    if job.output_markdown_path and job.status == PdfConversionStatus.CHUNKING.value:
        full_md = (await storage.read_bytes(job.output_markdown_path)).decode("utf-8")
        page_count = job.page_count or 1
        offsets = [(0, i + 1) for i in range(page_count)]
    elif job.output_markdown_path:
        full_md = (await storage.read_bytes(job.output_markdown_path)).decode("utf-8")
        pdf_bytes = await storage.read_bytes(job.input_file_path)
        page_pdfs = await asyncio.to_thread(pdf_split_service.split_pages, pdf_bytes)
        offsets = []
        offset = 0
        for idx in range(1, len(page_pdfs) + 1):
            offsets.append((offset, idx))
            offset += max(1, len(full_md) // len(page_pdfs))
    else:
        pdf_bytes = await storage.read_bytes(job.input_file_path)
        result = await _convert_pages(db, job, pdf_bytes)
        if result is None:
            return
        full_md, offsets = result

        md_bytes = full_md.encode("utf-8")
        md_key = f"users/{job.owner_id}/conversions/{job.id}/output.md"
        await storage.upload(md_key, md_bytes, "text/markdown; charset=utf-8")
        job.output_markdown_path = md_key
        job.markdown_size = len(md_bytes)
        job.progress = 85
        job.status = PdfConversionStatus.CHUNKING.value
        await db.commit()
        await _publish(job.id, status=job.status, progress=85, message="Markdown salvo")

    existing = await job_crud.list_chunk_summaries(db, job.id)
    if not existing:
        await _publish(job.id, status=job.status, progress=88, message="Gerando chunks")
        specs = chunking_service.chunk_markdown(full_md, offsets)
        if not specs:
            pdf_conversion_service.mark_failed(
                job,
                error_code=PdfConversionErrorCode.EMPTY_OUTPUT,
                message="Nenhum conteúdo gerado para chunking",
            )
            await db.commit()
            await _publish(
                job.id,
                status=job.status,
                progress=job.progress,
                error_code=job.error_code,
                error_message=job.error_message,
            )
            return

        chunk_models = pdf_conversion_service.chunks_to_models(job.id, specs)
        await job_crud.bulk_create_chunks(db, chunk_models)
        job.total_chunks = len(chunk_models)
        job.progress = 95
        await db.commit()
        await _publish(job.id, status=job.status, progress=95, message="Chunks prontos")

    job.status = PdfConversionStatus.COMPLETED.value
    job.progress = 100
    job.completed_at = datetime.now(UTC)
    job.error_code = None
    job.error_message = None
    await db.commit()
    await _publish(job.id, status=job.status, progress=100, message="Concluído")