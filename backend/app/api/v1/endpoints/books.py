import re
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.crud import book as book_crud
from app.crud import collection as collection_crud
from app.models.book import Book
from app.schemas.book import (
    BookPage,
    BookRead,
    BookUpdate,
    CollectionsUpdate,
    ProgressUpdate,
    ReaderState,
    TocUpdate,
)
from app.services import covers, metadata
from app.services.storage import storage

router = APIRouter(prefix="/books", tags=["books"])


async def _book_read(db: DbSession, book: Book) -> BookRead:
    """BookRead with the book's collection memberships attached."""
    ids = await collection_crud.collection_ids_for_book(db, book.id)
    return BookRead.model_validate(book).model_copy(update={"collection_ids": ids})


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


def _first_nonempty(*values: str | None) -> str | None:
    """First value that is non-empty after stripping, else None."""
    for value in values:
        if value is not None and value.strip():
            return value.strip()
    return None


def _validate_toc_tree(items: list[dict]) -> None:
    if not items:
        return
    previous_depth = 0
    for index, item in enumerate(items):
        depth = item["depth"]
        if index == 0:
            if depth != 0:
                raise HTTPException(422, "First table-of-contents entry must be top-level")
        elif depth > previous_depth + 1:
            raise HTTPException(422, "Table-of-contents nesting skips a level")
        previous_depth = depth


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
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form(max_length=512)] = None,
    author: Annotated[str | None, Form(max_length=255)] = None,
    collection_id: Annotated[int | None, Form()] = None,
    cover: Annotated[UploadFile | None, File()] = None,
) -> BookRead:
    if file.size is not None and file.size > _max_bytes():
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    if collection_id is not None:
        collection = await collection_crud.get_for_user(
            db, current_user.id, collection_id
        )
        if collection is None:
            raise HTTPException(404, "Collection not found")

    filename = file.filename or "upload"
    data = await file.read()
    if len(data) > _max_bytes():
        raise HTTPException(413, f"File exceeds {settings.MAX_UPLOAD_SIZE_MB} MB limit")

    file_format, content_type = _validate_file(filename, file.content_type, data)

    # Validate a manual cover (if any) up front, before storing anything.
    manual_cover = await _read_manual_cover(cover) if cover is not None else None

    # Auto-detect from the same bytes already read. Resolution order for each
    # field: client-provided value > embedded PDF metadata > filename (title only).
    meta = await metadata.extract_pdf_metadata(data)
    meta_title = meta["title"] if isinstance(meta["title"], str) else None
    meta_author = meta["author"] if isinstance(meta["author"], str) else None
    stem = filename[:-4] if filename.lower().endswith(".pdf") else filename
    resolved_title = (_first_nonempty(title, meta_title) or stem or "Untitled")[:512]
    resolved_author = _first_nonempty(author, meta_author)
    if resolved_author is not None:
        resolved_author = resolved_author[:255]
    page_count = meta["page_count"] if isinstance(meta["page_count"], int) else None

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
            title=resolved_title,
            author=resolved_author,
            file_format=file_format,
            content_type=content_type,
            file_size=len(data),
            original_filename=filename,
            object_key=object_key,
            page_count=page_count,
            cover_object_key=cover_key,
            cover_content_type=cover_content_type,
            cover_file_size=cover_file_size,
        )
        if collection_id is not None:
            await collection_crud.set_book_collections(
                db,
                user_id=current_user.id,
                book_id=book.id,
                collection_ids=[collection_id],
            )
    except SQLAlchemyError:
        await storage.delete(object_key)
        if cover_key is not None:
            await storage.delete(cover_key)
        raise

    return await _book_read(db, book)


@router.get("", response_model=BookPage)
async def list_books(
    current_user: CurrentUser,
    db: DbSession,
    search: Annotated[str | None, Query(max_length=200)] = None,
    collection_id: Annotated[int | None, Query()] = None,
    status: Annotated[
        Literal["all", "favorites", "plan_to_read", "completed"], Query()
    ] = "all",
    sort: Annotated[Literal["date", "title", "series"], Query()] = "date",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 12,
) -> BookPage:
    books, total = await book_crud.list_page(
        db,
        current_user.id,
        search=search,
        collection_id=collection_id,
        status=status,
        sort=sort,
        page=page,
        page_size=page_size,
    )
    coll_map = await collection_crud.collection_ids_for_books(db, [b.id for b in books])
    items = [
        BookRead.model_validate(b).model_copy(
            update={"collection_ids": coll_map.get(b.id, [])}
        )
        for b in books
    ]
    return BookPage(items=items, total=total, page=page, page_size=page_size)


@router.get("/{book_id}", response_model=BookRead)
async def get_book(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")
    return await _book_read(db, book)


@router.patch("/{book_id}", response_model=BookRead)
async def update_book(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: BookUpdate,
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:  # title present: must not be null/empty
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "Title cannot be empty")
        new_title = payload.title.strip()

    book = await book_crud.update_details(
        db,
        book,
        title=new_title,
        author=payload.author,
        set_author="author" in fields,
        is_favorite=payload.is_favorite,
        set_is_favorite="is_favorite" in fields,
    )
    return await _book_read(db, book)


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


@router.put("/{book_id}/progress", response_model=BookRead)
async def update_progress(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: ProgressUpdate,
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    last_page = min(payload.last_page, payload.page_count)
    book = await book_crud.set_progress(
        db, book, last_page=last_page, page_count=payload.page_count
    )
    return await _book_read(db, book)


@router.put("/{book_id}/reader-state", response_model=BookRead)
async def update_reader_state(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: ReaderState,
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    book = await book_crud.set_reader_state(
        db, book, reader_state=payload.model_dump(mode="json")
    )
    return await _book_read(db, book)


@router.put("/{book_id}/toc", response_model=BookRead)
async def update_toc(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: TocUpdate,
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    cleaned: list[dict] = []
    for entry in payload.items:
        title = entry.title.strip()
        if not title:
            raise HTTPException(422, "Title cannot be empty")
        if (
            entry.page is not None
            and book.page_count is not None
            and entry.page > book.page_count
        ):
            raise HTTPException(422, "Page cannot exceed the book page count")
        cleaned.append({"title": title, "page": entry.page, "depth": entry.depth})

    _validate_toc_tree(cleaned)
    book = await book_crud.set_toc(db, book, toc=cleaned or None)
    return await _book_read(db, book)


@router.put("/{book_id}/collections", response_model=BookRead)
async def set_book_collections(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: CollectionsUpdate,
) -> BookRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")

    await collection_crud.set_book_collections(
        db,
        user_id=current_user.id,
        book_id=book_id,
        collection_ids=payload.collection_ids,
    )
    return await _book_read(db, book)


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

    return await _book_read(db, book)


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
