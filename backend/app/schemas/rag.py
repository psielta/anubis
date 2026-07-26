"""Pydantic contracts for book RAG activate/status/query."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RagActivateResponse(BaseModel):
    document_id: uuid.UUID
    book_id: int
    status: str
    message: str = "RAG indexing enqueued"


class RagStatusResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    document_id: uuid.UUID = Field(validation_alias="id")
    book_id: int
    status: str
    progress: int
    chunk_count: int
    page_count: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class RagQueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=5, ge=1, le=20)


class RagSource(BaseModel):
    chunk_index: int
    page_start: int | None
    page_end: int | None
    title: str
    excerpt: str
    score: float | None = None


class RagQueryResponse(BaseModel):
    book_id: int
    question: str
    answer: str
    sources: list[RagSource]
