from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

MAX_LATEX_CONTENT = 200_000


class LatexNotebookGroupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    name: str
    position: int
    created_at: datetime
    updated_at: datetime


class LatexNotebookGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class LatexNotebookGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    position: int | None = Field(default=None, ge=0)


class LatexNotebookRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    group_id: int | None
    title: str
    content: str
    page: int | None
    created_at: datetime
    updated_at: datetime


class LatexNotebookCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=MAX_LATEX_CONTENT)
    group_id: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)


class LatexNotebookUpdate(BaseModel):
    # PATCH: omitted fields are unchanged. ``group_id`` and ``page`` may be sent
    # as null to move the notebook to Ungrouped or clear the page anchor.
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=MAX_LATEX_CONTENT)
    group_id: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)
