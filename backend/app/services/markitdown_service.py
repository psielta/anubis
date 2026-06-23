"""Page-by-page MarkItDown wrapper (sync; run in thread pool from worker)."""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path

from markitdown import MarkItDown


@dataclass(frozen=True)
class PageConversion:
    page_number: int
    markdown: str
    char_offset: int


@dataclass(frozen=True)
class ConversionResult:
    markdown: str
    page_offsets: list[tuple[int, int]]
    """List of (char_offset, page_number) sorted by offset."""


def convert_page(page_pdf: bytes, converter: MarkItDown | None = None) -> str:
    """Convert a single-page PDF blob to markdown."""
    md = converter or MarkItDown()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(page_pdf)
        tmp_path = Path(tmp.name)
    try:
        result = md.convert(str(tmp_path))
        return (result.text_content or "").strip()
    finally:
        tmp_path.unlink(missing_ok=True)


def convert_pages(page_pdfs: list[bytes]) -> ConversionResult:
    """Convert each page and build offset→page map."""
    parts: list[str] = []
    offsets: list[tuple[int, int]] = []
    offset = 0
    for idx, page_pdf in enumerate(page_pdfs, start=1):
        offsets.append((offset, idx))
        md = convert_page(page_pdf)
        if md:
            parts.append(md)
            offset += len(md)
            if idx < len(page_pdfs):
                parts.append("\n\n")
                offset += 2
    return ConversionResult(markdown="".join(parts), page_offsets=offsets)


def interpolate_progress(page_index: int, total_pages: int) -> int:
    """Map page progress into the 20–85% band."""
    if total_pages <= 0:
        return 20
    # Ceiling-style steps so page 1 of a large book still moves off 20%.
    return 20 + (page_index * 65 + total_pages - 1) // total_pages