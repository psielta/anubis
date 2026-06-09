from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class NoteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    title: str
    content: str
    page: int | None
    created_at: datetime
    updated_at: datetime


class NoteCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=500_000)  # Markdown source
    page: int | None = Field(default=None, ge=1)


class NoteUpdate(BaseModel):
    # PATCH: omitting a field leaves it unchanged. ``page`` may be sent as null to
    # clear the anchor. ``title`` cannot be null/empty -- the schema rejects "" via
    # min_length, and the endpoint rejects null and "   " (empty after strip) using
    # ``model_fields_set`` to tell "absent" from "explicitly null".
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=500_000)
    page: int | None = Field(default=None, ge=1)
