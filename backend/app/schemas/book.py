from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MAX_TOC_ENTRIES = 1000


class TocEntry(BaseModel):
    title: str = Field(min_length=1, max_length=512)
    page: int | None = Field(default=None, ge=1)
    depth: int = Field(default=0, ge=0, le=2)


class TocUpdate(BaseModel):
    # Replace the whole custom TOC. An empty list clears it back to the PDF's
    # embedded outline. Page upper-bound is enforced in the endpoint against the
    # book's page_count.
    items: list[TocEntry] = Field(max_length=MAX_TOC_ENTRIES)


class ReaderNotesState(BaseModel):
    view: Literal["list", "edit"] = "list"
    active_id: int | None = Field(default=None, ge=1)
    search: str = Field(default="", max_length=200)


class ReaderDiagramsState(BaseModel):
    view: Literal["list", "edit"] = "list"
    active_id: int | None = Field(default=None, ge=1)


class ReaderSketchesState(BaseModel):
    view: Literal["list", "edit"] = "list"
    active_id: int | None = Field(default=None, ge=1)
    active_group_id: int | None = Field(default=None, ge=1)
    search: str = Field(default="", max_length=200)


class ReaderLatexState(BaseModel):
    view: Literal["list", "edit"] = "list"
    active_id: int | None = Field(default=None, ge=1)
    active_group_id: int | None = Field(default=None, ge=1)
    search: str = Field(default="", max_length=200)


class ReaderExercisesState(BaseModel):
    view: Literal["list", "edit"] = "list"
    active_id: int | None = Field(default=None, ge=1)
    search: str = Field(default="", max_length=200)


class ReaderState(BaseModel):
    version: Literal[1] = 1
    zoom_pct: int = Field(default=100, ge=50, le=300)
    panel: Literal[
        "assistant",
        "diagrams",
        "exercises",
        "latex",
        "notes",
        "sketches",
        "toc",
        "content_tree",
        "translate",
    ] | None = None
    panel_width_px: int = Field(default=400, ge=320, le=2000)
    notes: ReaderNotesState = Field(default_factory=ReaderNotesState)
    diagrams: ReaderDiagramsState = Field(default_factory=ReaderDiagramsState)
    sketches: ReaderSketchesState = Field(default_factory=ReaderSketchesState)
    latex: ReaderLatexState = Field(default_factory=ReaderLatexState)
    exercises: ReaderExercisesState = Field(default_factory=ReaderExercisesState)


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
    is_favorite: bool = False
    last_page: int | None
    page_count: int | None
    toc: list[TocEntry] | None = None
    reader_state: ReaderState | None = None
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
    is_favorite: bool | None = None


class ProgressUpdate(BaseModel):
    last_page: int = Field(ge=1)
    page_count: int = Field(ge=1)


class CollectionsUpdate(BaseModel):
    collection_ids: list[int]
