from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PdfConversionCreateResponse(BaseModel):
    job_id: UUID


class PdfConversionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    original_filename: str
    status: str
    progress: int
    page_count: int | None
    error_code: str | None
    error_message: str | None
    total_chunks: int
    retry_count: int
    markdown_size: int | None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class PdfConversionEvent(BaseModel):
    job_id: UUID
    status: str
    progress: int
    message: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    timestamp: datetime
    seq: int | None = None


class ChunkSummary(BaseModel):
    chunk_index: int
    title: str
    page_start: int | None
    page_end: int | None
    content_length: int


class ChunkRead(BaseModel):
    chunk_index: int
    title: str
    page_start: int | None
    page_end: int | None
    content_markdown: str
    content_length: int


class TocEntry(BaseModel):
    chunk_index: int
    title: str
    depth: int = 1


class SearchHit(BaseModel):
    chunk_index: int
    title: str
    snippet: str
    rank: float


class SearchResponse(BaseModel):
    query: str
    hits: list[SearchHit] = Field(default_factory=list)