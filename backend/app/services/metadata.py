"""PDF metadata extraction for auto-filling book title/author/page count.

Like ``covers.render_pdf_cover`` this never raises: a malformed or unreadable
PDF must not break a book import. On any failure every field comes back ``None``
and the caller falls back to the filename. Runs off the event loop via
``asyncio.to_thread`` (same pattern as ``services.ai.extract_pages``).
"""

import asyncio

import pymupdf


def _clean(value: object) -> str | None:
    """Strip a metadata string; treat empty / whitespace-only as ``None``."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _extract(data: bytes) -> dict[str, object | None]:
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        return {"title": None, "author": None, "page_count": None}
    try:
        meta = doc.metadata or {}
        page_count = doc.page_count
        return {
            "title": _clean(meta.get("title")),
            "author": _clean(meta.get("author")),
            "page_count": page_count
            if isinstance(page_count, int) and page_count > 0
            else None,
        }
    except Exception:
        return {"title": None, "author": None, "page_count": None}
    finally:
        doc.close()


async def extract_pdf_metadata(data: bytes) -> dict[str, object | None]:
    """Return ``{"title": str|None, "author": str|None, "page_count": int|None}``.

    Never raises; any failure yields all ``None``. Runs off the event loop.
    """
    return await asyncio.to_thread(_extract, data)
