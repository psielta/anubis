from pydantic import BaseModel, ConfigDict, Field


class CollectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    book_count: int = 0


class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CollectionUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
