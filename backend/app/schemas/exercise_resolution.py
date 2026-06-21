from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_LATEX = 200_000
MAX_SKETCH = 2_000_000  # Excalidraw scene JSON grows with the drawing
MAX_STATEMENT = 20_000
MAX_FEEDBACK = 50_000

ExerciseStatus = Literal["pending", "completed", "doubt", "wrong"]
ExerciseAIMode = Literal["statement", "hint", "review"]


class RegionModel(BaseModel):
    # Normalized rectangle in [0, 1] of the page box (zoom-independent).
    x0: float = Field(ge=0, le=1)
    y0: float = Field(ge=0, le=1)
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _check_order(self) -> "RegionModel":
        if self.x1 <= self.x0 or self.y1 <= self.y0:
            raise ValueError("region must satisfy x1 > x0 and y1 > y0")
        return self


class ExerciseResolutionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    title: str
    page: int
    region: RegionModel
    statement: str
    latex_content: str
    sketch_content: str
    status: ExerciseStatus
    ai_feedback: str | None
    created_at: datetime
    updated_at: datetime


class ExerciseResolutionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    page: int = Field(ge=1)
    region: RegionModel
    statement: str = Field(default="", max_length=MAX_STATEMENT)
    latex_content: str = Field(default="", max_length=MAX_LATEX)
    sketch_content: str = Field(default="", max_length=MAX_SKETCH)


class ExerciseResolutionUpdate(BaseModel):
    # PATCH: omitted fields are unchanged. ``page`` and ``region`` are immutable
    # after the crop is created. ``ai_feedback`` may be sent null to clear it.
    title: str | None = Field(default=None, min_length=1, max_length=200)
    statement: str | None = Field(default=None, max_length=MAX_STATEMENT)
    latex_content: str | None = Field(default=None, max_length=MAX_LATEX)
    sketch_content: str | None = Field(default=None, max_length=MAX_SKETCH)
    status: ExerciseStatus | None = None
    ai_feedback: str | None = Field(default=None, max_length=MAX_FEEDBACK)


class ExerciseAttemptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    resolution_id: int
    latex_content: str
    sketch_content: str
    ai_feedback: str | None
    created_at: datetime


class ExerciseAIRequest(BaseModel):
    mode: ExerciseAIMode
    question: str | None = Field(default=None, max_length=2000)
