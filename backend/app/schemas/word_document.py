from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class WordDocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    title: str
    page: int | None
    file_size: int
    revision: int
    last_saved_at: datetime | None
    created_at: datetime
    updated_at: datetime


class WordDocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    page: int | None = Field(default=None, ge=1)


class WordDocumentUpdate(BaseModel):
    # PATCH: omitted fields are unchanged. ``page`` may be sent as null.
    title: str | None = Field(default=None, min_length=1, max_length=200)
    page: int | None = Field(default=None, ge=1)


class OnlyOfficeEditorConfig(BaseModel):
    document_server_url: str
    config: dict[str, Any]


class OnlyOfficeCallback(BaseModel):
    key: str
    status: int
    url: str | None = None
    filetype: str | None = None
    users: list[str] | None = None
    actions: list[dict[str, Any]] | None = None
    history: dict[str, Any] | None = None
    changesurl: str | None = None
