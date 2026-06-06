from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class BookRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    author: str | None
    file_format: str
    content_type: str
    file_size: int
    original_filename: str
    has_cover: bool
    last_page: int | None
    page_count: int | None
    collection_ids: list[int] = Field(default_factory=list)
    created_at: datetime


class BookPage(BaseModel):
    items: list[BookRead]
    total: int
    page: int
    page_size: int


class ProgressUpdate(BaseModel):
    last_page: int = Field(ge=1)
    page_count: int = Field(ge=1)


class CollectionsUpdate(BaseModel):
    collection_ids: list[int]