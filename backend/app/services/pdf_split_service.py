"""Split PDFs into single-page byte blobs using PyMuPDF."""

from __future__ import annotations

import fitz


class PdfSplitError(Exception):
    pass


def count_pages(pdf_bytes: bytes) -> int:
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise PdfSplitError("PDF inválido ou corrompido") from exc
    try:
        return doc.page_count
    finally:
        doc.close()


def split_pages(pdf_bytes: bytes) -> list[bytes]:
    """Return one single-page PDF per page (1-based order preserved)."""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise PdfSplitError("PDF inválido ou corrompido") from exc
    pages: list[bytes] = []
    try:
        for page_num in range(doc.page_count):
            single = fitz.open()
            single.insert_pdf(doc, from_page=page_num, to_page=page_num)
            pages.append(single.tobytes())
            single.close()
    finally:
        doc.close()
    return pages