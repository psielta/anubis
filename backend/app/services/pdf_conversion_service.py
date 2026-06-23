"""PDF conversion job lifecycle (HTTP-facing operations)."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.crud import outbox as outbox_crud
from app.crud import pdf_conversion as job_crud
from app.models.outbox import OutboxEventType
from app.models.pdf_conversion import (
    PdfConversionChunk,
    PdfConversionErrorCode,
    PdfConversionJob,
    PdfConversionStatus,
)
from app.services import pdf_split_service
from app.services.storage import storage

PDF_MAGIC = b"%PDF"
PDF_CONTENT_TYPE = "application/pdf"


def _max_bytes() -> int:
    return settings.PDF_CONVERSION_MAX_UPLOAD_MB * 1024 * 1024


def _sanitize_filename(name: str) -> str:
    safe = re.sub(r'["\\\r\n]', "_", name)
    return safe or "upload.pdf"


async def validate_and_read_pdf(file: UploadFile) -> tuple[str, bytes, int]:
    if file.size is not None and file.size > _max_bytes():
        raise HTTPException(
            413,
            f"O arquivo excede o limite de {settings.PDF_CONVERSION_MAX_UPLOAD_MB} MB",
        )
    filename = _sanitize_filename(file.filename or "upload.pdf")
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(415, "Apenas arquivos PDF são suportados")

    data = await file.read()
    if len(data) > _max_bytes():
        raise HTTPException(
            413,
            f"O arquivo excede o limite de {settings.PDF_CONVERSION_MAX_UPLOAD_MB} MB",
        )
    if not data.startswith(PDF_MAGIC):
        raise HTTPException(415, "O conteúdo do arquivo não corresponde ao formato PDF")

    declared = file.content_type or ""
    if declared and declared != PDF_CONTENT_TYPE:
        raise HTTPException(415, "O conteúdo do arquivo não corresponde ao formato PDF")

    try:
        page_count = pdf_split_service.count_pages(data)
    except pdf_split_service.PdfSplitError as exc:
        raise HTTPException(415, str(exc)) from exc

    if page_count == 0:
        raise HTTPException(422, "O PDF não contém páginas")
    if page_count > settings.PDF_CONVERSION_MAX_PAGES:
        raise HTTPException(
            413,
            f"O PDF excede o limite de {settings.PDF_CONVERSION_MAX_PAGES} páginas",
        )

    return filename, data, page_count


async def create_conversion_job(
    db: AsyncSession,
    *,
    owner_id: int,
    filename: str,
    pdf_bytes: bytes,
    page_count: int,
) -> PdfConversionJob:
    job_id = uuid.uuid4()
    object_key = f"users/{owner_id}/conversions/{job_id}/input.pdf"
    await storage.upload(object_key, pdf_bytes, PDF_CONTENT_TYPE)

    job = await job_crud.create_job(
        db,
        owner_id=owner_id,
        tenant_id=owner_id,
        original_filename=filename,
        input_file_path=object_key,
    )
    job.page_count = page_count
    job.progress = 10

    await outbox_crud.enqueue(
        db,
        aggregate_id=job.id,
        event_type=OutboxEventType.PDF_CONVERSION_REQUESTED,
        payload={"job_id": str(job.id)},
    )
    await db.commit()
    await db.refresh(job)
    return job


async def get_owned_job(
    db: AsyncSession, owner_id: int, job_id: uuid.UUID
) -> PdfConversionJob:
    job = await job_crud.get_for_owner(db, owner_id, job_id)
    if job is None:
        raise HTTPException(404, "Conversão não encontrada")
    return job


async def retry_job(db: AsyncSession, job: PdfConversionJob) -> PdfConversionJob:
    if job.status != PdfConversionStatus.FAILED.value:
        raise HTTPException(400, "Retry permitido apenas para jobs com falha")

    if job.output_markdown_path:
        try:
            await storage.delete(job.output_markdown_path)
        except Exception:
            pass

    await job_crud.delete_chunks_for_job(db, job.id)

    job.status = PdfConversionStatus.PENDING.value
    job.progress = 0
    job.error_code = None
    job.error_message = None
    job.output_markdown_path = None
    job.markdown_size = None
    job.total_chunks = 0
    job.started_at = None
    job.completed_at = None
    job.cancel_requested = False
    job.retry_count += 1

    await outbox_crud.enqueue(
        db,
        aggregate_id=job.id,
        event_type=OutboxEventType.PDF_CONVERSION_RETRY_REQUESTED,
        payload={"job_id": str(job.id)},
    )
    await db.commit()
    await db.refresh(job)
    return job


async def cancel_job(db: AsyncSession, job: PdfConversionJob) -> PdfConversionJob:
    terminal = {
        PdfConversionStatus.COMPLETED.value,
        PdfConversionStatus.FAILED.value,
        PdfConversionStatus.CANCELED.value,
    }
    if job.status in terminal:
        raise HTTPException(400, "Job já está em estado terminal")

    job.cancel_requested = True
    await outbox_crud.enqueue(
        db,
        aggregate_id=job.id,
        event_type=OutboxEventType.PDF_CONVERSION_CANCEL_REQUESTED,
        payload={"job_id": str(job.id)},
    )
    await db.commit()
    await db.refresh(job)
    return job


def chunks_to_models(job_id: uuid.UUID, specs: list) -> list[PdfConversionChunk]:
    from app.services.chunking_service import ChunkSpec

    models: list[PdfConversionChunk] = []
    for spec in specs:
        assert isinstance(spec, ChunkSpec)
        content = spec.content_markdown
        models.append(
            PdfConversionChunk(
                job_id=job_id,
                chunk_index=spec.chunk_index,
                title=spec.title[:512],
                page_start=spec.page_start,
                page_end=spec.page_end,
                content_markdown=content,
                content_length=len(content),
            )
        )
    return models


def mark_failed(
    job: PdfConversionJob,
    *,
    error_code: PdfConversionErrorCode,
    message: str,
) -> None:
    job.status = PdfConversionStatus.FAILED.value
    job.error_code = error_code.value
    job.error_message = message
    job.completed_at = datetime.now(UTC)


def mark_canceled(job: PdfConversionJob) -> None:
    job.status = PdfConversionStatus.CANCELED.value
    job.error_code = PdfConversionErrorCode.CANCELED.value
    job.error_message = "Conversão cancelada pelo usuário"
    job.completed_at = datetime.now(UTC)
    job.progress = job.progress  # keep last progress