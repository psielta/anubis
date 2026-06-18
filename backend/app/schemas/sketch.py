from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

MAX_SKETCH_CONTENT = 5_000_000


class SketchGroupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    name: str
    position: int
    created_at: datetime
    updated_at: datetime


class SketchGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class SketchGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    position: int | None = Field(default=None, ge=0)


class SketchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    group_id: int | None
    title: str
    content: str
    page: int | None
    created_at: datetime
    updated_at: datetime


class SketchCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=MAX_SKETCH_CONTENT)
    group_id: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)


class SketchUpdate(BaseModel):
    # PATCH: omitted fields are unchanged. ``group_id`` and ``page`` may be sent
    # as null to move the sketch to Ungrouped or clear the page anchor.
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=MAX_SKETCH_CONTENT)
    group_id: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)
