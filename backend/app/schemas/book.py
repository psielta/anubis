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


class BookUpdate(BaseModel):
    # PATCH: omitting a field leaves it unchanged. ``author`` may be sent as null
    # to clear it. ``title`` cannot be null/empty -- the schema rejects "" via
    # min_length, and the endpoint rejects null and "   " (empty after strip)
    # using ``model_fields_set`` to tell "absent" from "explicitly null".
    title: str | None = Field(default=None, min_length=1, max_length=512)
    author: str | None = Field(default=None, max_length=255)


class ProgressUpdate(BaseModel):
    last_page: int = Field(ge=1)
    page_count: int = Field(ge=1)


class CollectionsUpdate(BaseModel):
    collection_ids: list[int]