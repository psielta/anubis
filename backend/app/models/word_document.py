from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class WordDocument(Base):
    __tablename__ = "word_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    page: Mapped[int | None] = mapped_column(default=None)
    object_key: Mapped[str] = mapped_column(String(1024), unique=True)
    file_size: Mapped[int] = mapped_column(BigInteger)
    content_type: Mapped[str] = mapped_column(
        String(120),
        default="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    last_saved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
