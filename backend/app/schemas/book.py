from datetime import datetime

from pydantic import BaseModel, ConfigDict


class BookRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    author: str | None
    file_format: str
    content_type: str
    file_size: int
    original_filename: str
    created_at: datetime