from collections.abc import Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import Book
from app.models.collection import book_collections


async def create(
    db: AsyncSession,
    *,
    user_id: int,
    title: str,
    author: str | None,
    file_format: str,
    content_type: str,
    file_size: int,
    original_filename: str,
    object_key: str,
    page_count: int | None = None,
    cover_object_key: str | None = None,
    cover_content_type: str | None = None,
    cover_file_size: int | None = None,
) -> Book:
    book = Book(
        user_id=user_id,
        title=title,
        author=author,
        file_format=file_format,
        content_type=content_type,
        file_size=file_size,
        original_filename=original_filename,
        object_key=object_key,
        page_count=page_count,
        cover_object_key=cover_object_key,
        cover_content_type=cover_content_type,
        cover_file_size=cover_file_size,
    )
    db.add(book)
    await db.commit()
    await db.refresh(book)
    return book


async def set_cover(
    db: AsyncSession,
    book: Book,
    *,
    object_key: str,
    content_type: str,
    file_size: int,
) -> Book:
    book.cover_object_key = object_key
    book.cover_content_type = content_type
    book.cover_file_size = file_size
    await db.commit()
    await db.refresh(book)
    return book


async def clear_cover(db: AsyncSession, book: Book) -> Book:
    book.cover_object_key = None
    book.cover_content_type = None
    book.cover_file_size = None
    await db.commit()
    await db.refresh(book)
    return book


async def set_progress(
    db: AsyncSession, book: Book, *, last_page: int, page_count: int
) -> Book:
    book.last_page = last_page
    book.page_count = page_count
    await db.commit()
    await db.refresh(book)
    return book


async def update_details(
    db: AsyncSession,
    book: Book,
    *,
    title: str | None = None,
    author: str | None = None,
    set_author: bool = False,
) -> Book:
    """Patch title/author. ``title`` is applied only when not None; ``author`` is
    applied (including to None, to clear it) only when ``set_author`` is True."""
    if title is not None:
        book.title = title
    if set_author:
        book.author = author
    await db.commit()
    await db.refresh(book)
    return book


async def list_page(
    db: AsyncSession,
    user_id: int,
    *,
    search: str | None = None,
    collection_id: int | None = None,
    page: int = 1,
    page_size: int = 12,
) -> tuple[Sequence[Book], int]:
    base = select(Book).where(Book.user_id == user_id)
    if search:
        like = f"%{search.strip()}%"
        base = base.where(or_(Book.title.ilike(like), Book.author.ilike(like)))
    if collection_id is not None:
        base = base.join(
            book_collections, book_collections.c.book_id == Book.id
        ).where(book_collections.c.collection_id == collection_id)

    total = await db.scalar(select(func.count()).select_from(base.subquery())) or 0
    stmt = (
        base.order_by(Book.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    books = (await db.scalars(stmt)).all()
    return books, total


async def get_for_user(db: AsyncSession, user_id: int, book_id: int) -> Book | None:
    return await db.scalar(
        select(Book).where(Book.id == book_id, Book.user_id == user_id)
    )


async def delete(db: AsyncSession, book: Book) -> None:
    await db.delete(book)
    await db.commit()