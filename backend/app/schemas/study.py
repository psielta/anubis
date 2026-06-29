from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.exercise_resolution import RegionModel


class StudyMessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    kind: str
    content: str
    scope: str | None
    created_at: datetime


class StudyVisualSelection(BaseModel):
    page: int = Field(ge=1)
    region: RegionModel


class StudyRequest(BaseModel):
    kind: Literal["chat", "summary", "flashcards"]
    question: str | None = None
    scope: Literal["book", "chapter", "pages"] = "book"
    page_from: int | None = Field(default=None, ge=1)
    page_to: int | None = Field(default=None, ge=1)
    selection: str | None = None
    visual_selection: StudyVisualSelection | None = None

    @model_validator(mode="after")
    def _check_page_range(self) -> "StudyRequest":
        if self.page_from is not None and self.page_to is not None:
            if self.page_to < self.page_from:
                raise ValueError("page_to must be greater than or equal to page_from")
        return self
