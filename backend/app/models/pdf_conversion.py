import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PdfConversionStatus(str, enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    CHUNKING = "chunking"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


class PdfConversionErrorCode(str, enum.Enum):
    SCANNED_NO_TEXT = "scanned_no_text"
    TOO_LARGE = "too_large"
    CONVERSION_FAILED = "conversion_failed"
    TIMEOUT = "timeout"
    EMPTY_OUTPUT = "empty_output"
    INVALID_PDF = "invalid_pdf"
    CANCELED = "canceled"


class PdfConversionJob(Base):
    __tablename__ = "pdf_conversion_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    tenant_id: Mapped[int] = mapped_column(index=True)
    original_filename: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(
        String(16), default=PdfConversionStatus.PENDING.value, index=True
    )
    progress: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    page_count: Mapped[int | None] = mapped_column(Integer, default=None)
    error_code: Mapped[str | None] = mapped_column(String(32), default=None)
    error_message: Mapped[str | None] = mapped_column(Text, default=None)
    input_file_path: Mapped[str] = mapped_column(String(1024))
    output_markdown_path: Mapped[str | None] = mapped_column(String(1024), default=None)
    markdown_size: Mapped[int | None] = mapped_column(BigInteger, default=None)
    total_chunks: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    retry_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cancel_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )


class PdfConversionChunk(Base):
    __tablename__ = "pdf_conversion_chunks"
    __table_args__ = (
        UniqueConstraint("job_id", "chunk_index", name="uq_pdf_chunk_job_index"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("pdf_conversion_jobs.id", ondelete="CASCADE"), index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(512))
    page_start: Mapped[int | None] = mapped_column(Integer, default=None)
    page_end: Mapped[int | None] = mapped_column(Integer, default=None)
    content_markdown: Mapped[str] = mapped_column(Text)
    content_length: Mapped[int] = mapped_column(Integer)
    search_tsv: Mapped[str | None] = mapped_column(TSVECTOR, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )