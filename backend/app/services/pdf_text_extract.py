"""Page-aware PDF text extraction for RAG indexing."""

from __future__ import annotations

from dataclasses import dataclass

import pymupdf


class PdfTextExtractError(Exception):
    """Raised when PDF text extraction fails."""


@dataclass(frozen=True)
class PageText:
    page_number: int  # 1-based
    text: str


@dataclass(frozen=True)
class ExtractedDocument:
    pages: list[PageText]
    full_text: str
    page_offsets: list[tuple[int, int]]  # (char_offset, page_number)


def extract_pages(pdf_bytes: bytes) -> ExtractedDocument:
    """
    Extract plain text per page and build a continuous full_text with page offsets.

    page_offsets maps absolute character offsets in full_text to 1-based page numbers
    (offset of the first character contributed by that page).
    """
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 — surface as domain error
        raise PdfTextExtractError(f"invalid PDF: {exc}") from exc

    try:
        pages: list[PageText] = []
        parts: list[str] = []
        page_offsets: list[tuple[int, int]] = []
        cursor = 0

        for i in range(doc.page_count):
            page = doc.load_page(i)
            raw = page.get_text("text") or ""
            # Normalize line endings; strip NULs (Postgres UTF-8 rejects 0x00).
            text = (
                raw.replace("\x00", "")
                .replace("\r\n", "\n")
                .replace("\r", "\n")
                .strip()
            )
            page_num = i + 1
            pages.append(PageText(page_number=page_num, text=text))
            if text:
                if parts:
                    # Separate pages with blank line so chunker can respect boundaries.
                    sep = "\n\n"
                    cursor += len(sep)
                    parts.append(sep)
                page_offsets.append((cursor, page_num))
                parts.append(text)
                cursor += len(text)

        full_text = "".join(parts)
        return ExtractedDocument(
            pages=pages, full_text=full_text, page_offsets=page_offsets
        )
    finally:
        doc.close()


def page_count(pdf_bytes: bytes) -> int:
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise PdfTextExtractError(f"invalid PDF: {exc}") from exc
    try:
        return int(doc.page_count)
    finally:
        doc.close()
