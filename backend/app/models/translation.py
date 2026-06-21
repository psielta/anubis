from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PageTranslation(Base):
    """Cached Markdown translation of a single PDF page, per book and language."""

    __tablename__ = "page_translations"
    __table_args__ = (
        UniqueConstraint("book_id", "page", "lang", name="uq_page_translation"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), index=True
    )
    page: Mapped[int] = mapped_column(Integer)  # 1-based physical PDF page
    lang: Mapped[str] = mapped_column(String(16), default="pt-BR")
    markdown: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
