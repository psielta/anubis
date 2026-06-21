from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ExerciseResolution(Base):
    __tablename__ = "exercise_resolutions"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(
        ForeignKey("books.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    page: Mapped[int] = mapped_column()  # 1-based PDF page of the crop
    region: Mapped[dict[str, float]] = mapped_column(
        JSONB
    )  # normalized {x0, y0, x1, y1} in [0, 1] of the page box
    statement: Mapped[str] = mapped_column(Text, default="")  # extracted enunciado
    latex_content: Mapped[str] = mapped_column(Text, default="")  # LaTeX worksheet
    sketch_content: Mapped[str] = mapped_column(Text, default="")  # Excalidraw scene
    status: Mapped[str] = mapped_column(
        String(16), default="pending"
    )  # 'pending' | 'completed' | 'doubt' | 'wrong'
    ai_feedback: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ExerciseAttempt(Base):
    __tablename__ = "exercise_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    resolution_id: Mapped[int] = mapped_column(
        ForeignKey("exercise_resolutions.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    latex_content: Mapped[str] = mapped_column(Text, default="")
    sketch_content: Mapped[str] = mapped_column(Text, default="")
    ai_feedback: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
