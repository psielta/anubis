import re
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.crud import book as book_crud
from app.schemas.book import BookRead
from app.services import covers
from app.services.storage import storage

router = APIRouter(prefix="/books", tags=["books"])

PDF_MAGIC = b"%PDF"
PDF_CONTENT_TYPE = "application/pdf"
ALLOWED_EXTENSIONS = {".pdf": "pdf"}


def _validate_file(
    filename: str, content_type: str | None, data: bytes
) -> tuple[str, str]:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, "Only PDF files are supported")

    declared = content_type or ""
    if declared != PDF_CONTENT_TYPE or not data.startswith(PDF_MAGIC):
        raise HTTPException(415, "File content does not match PDF format")

    return ALLOWED_EXTENSIONS[ext], declared


def _sanitize_filename(name: str) -> str:
    safe = re.sub(r'["\\\r\n]', "_", name)
    return safe or "download"


def _max_bytes() -> int:
    return settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024


def _max_cover_bytes() -> int:
    return settings.MAX_COVER_SIZE_MB * 1024 * 1024


async def _read_manual_cover(cover: UploadFile) -> tuple[bytes, str]:
    """Read and strictly validate a user-uploaded cover image."""
    data = await cover.read()
    if len(data) > _max_cover_bytes():
        raise HTTPException(413, f"Cover exceeds {settings.MAX_COVER_SIZE_MB} MB limit")
    content_type = covers.validate_image(cover.content_type, data)
    return data, content_type


async def _store_cover(user_id: int, data: bytes, content_type: str) -> str:
    ext = covers.IMAGE_EXTENSIONS[content_type]
    key = f"users/{user_id}/covers/{uuid4().hex}.{ext}"
    await storage.upload(key, data, content_type)
    return key


@router.post("", response_model=BookRead, status_code=201)
async def import_book(
    current_user: CurrentUser,
    db: DbSession,
    title: Annotated[str, Form(min_length=1, max_length=512)],
    file: Annotated[UploadFile, File()],
    author: Annotated[str | None, Form(max_length=255)] = None,
    cover: Annotated[UploadFile | None, File()] = None,
) -> BookRead:
    if file.size is not None and file.size > _max_bytes():
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    filename = file.filename or "upload"
    data = await file.read()
    if len(data) > _max_bytes():
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    file_format, content_type = _validate_file(filename, file.content_type, data)

    # Validate a manual cover (if any) up front, before storing anything.
    manual_cover = await _read_manual_cover(cover) if cover is not None else None

    object_key = f"users/{current_user.id}/books/{uuid4().hex}.{file_format}"
    await storage.upload(object_key, data, content_type)

    cover_key: str | None = None
    cover_content_type: str | None = None
    cover_file_size: int | None = None
    try:
        resolved_cover = manual_cover
        if resolved_cover is None:
            resolved_cover = covers.render_pdf_cover(data)
        if resolved_cover is not None:
            cover_data, cover_content_type = resolved_cover
            cover_key = await _store_cover(
                current_user.id, cover_data, cover_content_type
            )
            cover_file_size = len(cover_data)

        book = await book_crud.create(
            db,
            user_id=current_user.id,
            title=title,
            author=author,
            file_format=file_format,
            content_type=content_type,
            file_size=len(data),
            original_filename=filename,
            object_key=object_key,
            cover_object_key=cover_key,
            cover_content_type=cover_content_type,
            cover_file_size=cover_file_size,
        )
    except SQLAlchemyError:
        await storage.delete(object_key)
        if cover_key is not None:
            await storage.delete(cover_key)
        raise

    return BookRead.model_validate(book)


@router.get("", response_model=list[BookRead])
async def list_books(current_user: CurrentUser, db: DbSession) -> list[BookRead]:
    books = await book_crud.list_for_user(db, current_user.id)
    return [BookRead.model_validate(b) for b in books]


@router.get("/{book_id}", response_model=BookRead)
async def get_book(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")
    return BookRead.model_validate(book)


@router.get("/{book_id}/file")
async def download_book(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> StreamingResponse:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    safe_name = _sanitize_filename(book.original_filename)
    return StreamingResponse(
        storage.stream(book.object_key),
        media_type=book.content_type,
        headers={
            "Content-Length": str(book.file_size),
            "Content-Disposition": f'attachment; filename="{safe_name}"',
        },
    )


@router.post("/{book_id}/cover", response_model=BookRead)
async def set_book_cover(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    cover: Annotated[UploadFile, File()],
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    cover_data, content_type = await _read_manual_cover(cover)
    new_key = await _store_cover(current_user.id, cover_data, content_type)
    old_key = book.cover_object_key

    try:
        book = await book_crud.set_cover(
            db,
            book,
            object_key=new_key,
            content_type=content_type,
            file_size=len(cover_data),
        )
    except SQLAlchemyError:
        await storage.delete(new_key)
        raise

    if old_key is not None and old_key != new_key:
        await storage.delete(old_key)

    return BookRead.model_validate(book)


@router.get("/{book_id}/cover")
async def get_book_cover(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> StreamingResponse:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None or book.cover_object_key is None:
        raise HTTPException(404, "Cover not found")

    return StreamingResponse(
        storage.stream(book.cover_object_key),
        media_type=book.cover_content_type or "application/octet-stream",
        headers={
            "Content-Length": str(book.cover_file_size or 0),
            "Content-Disposition": "inline",
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.delete("/{book_id}/cover", status_code=204)
async def delete_book_cover(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    cover_key = book.cover_object_key
    if cover_key is None:
        return

    await book_crud.clear_cover(db, book)
    await storage.delete(cover_key)


@router.delete("/{book_id}", status_code=204)
async def delete_book(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    object_key = book.object_key
    cover_key = book.cover_object_key
    await book_crud.delete(db, book)
    await storage.delete(object_key)
    if cover_key is not None:
        await storage.delete(cover_key)