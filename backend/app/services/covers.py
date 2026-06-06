"""Cover image helpers: validation and PDF first-page rendering.

``render_pdf_cover`` never raises — a missing or unreadable cover must not break
a book import. Only explicit user uploads are validated strictly.
"""

import pymupdf
from fastapi import HTTPException

_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# Supported raster cover formats. SVG is intentionally excluded.
IMAGE_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


def detect_image(data: bytes) -> str | None:
    """Return the content type inferred from magic bytes, or None."""
    if data.startswith(_JPEG_MAGIC):
        return "image/jpeg"
    if data.startswith(_PNG_MAGIC):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_image(declared_content_type: str | None, data: bytes) -> str:
    """Validate an uploaded cover and return its canonical content type.

    Magic bytes are the source of truth; the declared type, when present, must
    not contradict them. Raises HTTP 415 on anything that is not JPEG/PNG/WebP.
    """
    detected = detect_image(data)
    if detected is None:
        raise HTTPException(415, "Cover must be a JPEG, PNG or WebP image")

    declared = (declared_content_type or "").split(";")[0].strip().lower()
    if declared and declared in IMAGE_EXTENSIONS and declared != detected:
        raise HTTPException(415, "Cover content type does not match image data")
    return detected


def render_pdf_cover(data: bytes) -> tuple[bytes, str] | None:
    """Render the first page of a PDF to a PNG, as (bytes, content_type)."""
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
        try:
            if doc.page_count == 0:
                return None
            page = doc.load_page(0)
            width = page.rect.width or 0
            zoom = 700 / width if width else 1.0
            zoom = max(0.5, min(zoom, 3.0))
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            return pixmap.tobytes("png"), "image/png"
        finally:
            doc.close()
    except Exception:
        return None
