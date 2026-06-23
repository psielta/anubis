from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse

from app.api.deps import CurrentUser, DbSession
from app.crud import pdf_conversion as job_crud
from app.models.pdf_conversion import PdfConversionStatus
from app.schemas.pdf_conversion import (
    ChunkRead,
    ChunkSummary,
    PdfConversionCreateResponse,
    PdfConversionRead,
    SearchHit,
    SearchResponse,
    TocEntry,
)
from app.services import pdf_conversion_service
from app.services.redis_pubsub_service import redis_pubsub
from app.services.sse_service import stream_job_events
from app.services.storage import storage

router = APIRouter(prefix="/pdf-conversions", tags=["pdf-conversions"])


@router.post("", response_model=PdfConversionCreateResponse, status_code=201)
async def upload_pdf(
    current_user: CurrentUser,
    db: DbSession,
    file: Annotated[UploadFile, File()],
) -> PdfConversionCreateResponse:
    filename, data, page_count = await pdf_conversion_service.validate_and_read_pdf(
        file
    )
    job = await pdf_conversion_service.create_conversion_job(
        db,
        owner_id=current_user.id,
        filename=filename,
        pdf_bytes=data,
        page_count=page_count,
    )
    return PdfConversionCreateResponse(job_id=job.id)


@router.get("/{job_id}", response_model=PdfConversionRead)
async def get_job(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> PdfConversionRead:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    return PdfConversionRead.model_validate(job)


@router.get("/{job_id}/events")
async def job_events(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> StreamingResponse:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    return StreamingResponse(
        stream_job_events(job, redis_pubsub),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{job_id}/markdown")
async def download_markdown(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> PlainTextResponse:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    if job.status != PdfConversionStatus.COMPLETED.value or not job.output_markdown_path:
        raise HTTPException(400, "Markdown ainda não disponível")
    data = await storage.read_bytes(job.output_markdown_path)
    return PlainTextResponse(
        content=data.decode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{job.original_filename}.md"'
        },
    )


@router.get("/{job_id}/chunks", response_model=list[ChunkSummary])
async def list_chunks(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> list[ChunkSummary]:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    if job.status != PdfConversionStatus.COMPLETED.value:
        raise HTTPException(400, "Chunks disponíveis apenas após conclusão")
    chunks = await job_crud.list_chunk_summaries(db, job.id)
    return [
        ChunkSummary(
            chunk_index=c.chunk_index,
            title=c.title,
            page_start=c.page_start,
            page_end=c.page_end,
            content_length=c.content_length,
        )
        for c in chunks
    ]


@router.get("/{job_id}/chunks/{chunk_index}", response_model=ChunkRead)
async def get_chunk(
    job_id: UUID,
    chunk_index: int,
    current_user: CurrentUser,
    db: DbSession,
) -> ChunkRead:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    if job.status != PdfConversionStatus.COMPLETED.value:
        raise HTTPException(400, "Chunks disponíveis apenas após conclusão")
    chunk = await job_crud.get_chunk(db, job.id, chunk_index)
    if chunk is None:
        raise HTTPException(404, "Chunk não encontrado")
    return ChunkRead(
        chunk_index=chunk.chunk_index,
        title=chunk.title,
        page_start=chunk.page_start,
        page_end=chunk.page_end,
        content_markdown=chunk.content_markdown,
        content_length=chunk.content_length,
    )


@router.get("/{job_id}/toc", response_model=list[TocEntry])
async def get_toc(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> list[TocEntry]:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    if job.status != PdfConversionStatus.COMPLETED.value:
        raise HTTPException(400, "Sumário disponível apenas após conclusão")
    chunks = await job_crud.list_chunk_summaries(db, job.id)
    return [
        TocEntry(chunk_index=c.chunk_index, title=c.title, depth=1) for c in chunks
    ]


@router.get("/{job_id}/search", response_model=SearchResponse)
async def search_chunks(
    job_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=200)],
) -> SearchResponse:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    if job.status != PdfConversionStatus.COMPLETED.value:
        raise HTTPException(400, "Busca disponível apenas após conclusão")
    hits = await job_crud.search_chunks(db, job.id, q)
    return SearchResponse(
        query=q,
        hits=[
            SearchHit(
                chunk_index=c.chunk_index,
                title=c.title,
                snippet=snippet,
                rank=rank,
            )
            for c, snippet, rank in hits
        ],
    )


@router.post("/{job_id}/retry", response_model=PdfConversionRead)
async def retry_conversion(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> PdfConversionRead:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    job = await pdf_conversion_service.retry_job(db, job)
    return PdfConversionRead.model_validate(job)


@router.post("/{job_id}/cancel", response_model=PdfConversionRead)
async def cancel_conversion(
    job_id: UUID, current_user: CurrentUser, db: DbSession
) -> PdfConversionRead:
    job = await pdf_conversion_service.get_owned_job(db, current_user.id, job_id)
    job = await pdf_conversion_service.cancel_job(db, job)
    return PdfConversionRead.model_validate(job)