from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Book(Base):
    __tablename__ = "books"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(512))
    author: Mapped[str | None] = mapped_column(String(255), default=None)
    file_format: Mapped[str] = mapped_column(String(10))
    content_type: Mapped[str] = mapped_column(String(100))
    file_size: Mapped[int] = mapped_column(BigInteger)
    original_filename: Mapped[str] = mapped_column(String(512))
    object_key: Mapped[str] = mapped_column(String(1024), unique=True)
    cover_object_key: Mapped[str | None] = mapped_column(
        String(1024), unique=True, default=None
    )
    cover_content_type: Mapped[str | None] = mapped_column(String(100), default=None)
    cover_file_size: Mapped[int | None] = mapped_column(BigInteger, default=None)
    last_page: Mapped[int | None] = mapped_column(default=None)
    page_count: Mapped[int | None] = mapped_column(default=None)
    toc: Mapped[list[dict] | None] = mapped_column(JSONB, default=None)
    ai_file_name: Mapped[str | None] = mapped_column(String(256), default=None)
    ai_file_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    @property
    def has_cover(self) -> bool:
        return self.cover_object_key is not None
