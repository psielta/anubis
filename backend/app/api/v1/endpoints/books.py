import io
import re
import zipfile
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.crud import book as book_crud
from app.schemas.book import BookRead
from app.services.storage import storage

router = APIRouter(prefix="/books", tags=["books"])

PDF_MAGIC = b"%PDF"
PDF_CONTENT_TYPE = "application/pdf"
EPUB_CONTENT_TYPE = "application/epub+zip"
ALLOWED_EXTENSIONS = {".pdf": "pdf", ".epub": "epub"}
ALLOWED_CONTENT_TYPES = {PDF_CONTENT_TYPE, EPUB_CONTENT_TYPE}


def is_epub(data: bytes) -> bool:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            return zf.read("mimetype").decode("ascii").strip() == EPUB_CONTENT_TYPE
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError):
        return False


def _validate_file(
    filename: str, content_type: str | None, data: bytes
) -> tuple[str, str]:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, "Only PDF and EPUB files are supported")

    declared = content_type or ""
    if declared not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(415, "Invalid content type for book upload")

    file_format = ALLOWED_EXTENSIONS[ext]
    if file_format == "pdf":
        if declared != PDF_CONTENT_TYPE or not data.startswith(PDF_MAGIC):
            raise HTTPException(415, "File content does not match PDF format")
    elif declared != EPUB_CONTENT_TYPE or not is_epub(data):
        raise HTTPException(415, "File content does not match EPUB format")

    return file_format, declared


def _sanitize_filename(name: str) -> str:
    safe = re.sub(r'["\\\r\n]', "_", name)
    return safe or "download"


def _max_bytes() -> int:
    return settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024


@router.post("", response_model=BookRead, status_code=201)
async def import_book(
    current_user: CurrentUser,
    db: DbSession,
    title: Annotated[str, Form(min_length=1, max_length=512)],
    file: Annotated[UploadFile, File()],
    author: Annotated[str | None, Form(max_length=255)] = None,
) -> BookRead:
    if file.size is not None and file.size > _max_bytes():
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    filename = file.filename or "upload"
    data = await file.read()
    if len(data) > _max_bytes():
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    file_format, content_type = _validate_file(filename, file.content_type, data)

    object_key = f"users/{current_user.id}/books/{uuid4().hex}.{file_format}"
    await storage.upload(object_key, data, content_type)

    try:
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
        )
    except SQLAlchemyError:
        await storage.delete(object_key)
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


@router.delete("/{book_id}", status_code=204)
async def delete_book(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    object_key = book.object_key
    await book_crud.delete(db, book)
    await storage.delete(object_key)