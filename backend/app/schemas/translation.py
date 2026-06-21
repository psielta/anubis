from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TranslationRequest(BaseModel):
    page: int = Field(ge=1)
    force: bool = False


class TranslationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    page: int
    lang: str
    markdown: str
    model: str
    created_at: datetime
