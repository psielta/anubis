from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class StudyMessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    kind: str
    content: str
    scope: str | None
    created_at: datetime


class StudyRequest(BaseModel):
    kind: Literal["chat", "summary", "flashcards"]
    question: str | None = None
    scope: Literal["book", "chapter"] = "book"
    page_from: int | None = None
    page_to: int | None = None
    selection: str | None = None
