from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import Book


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
    )
    db.add(book)
    await db.commit()
    await db.refresh(book)
    return book


async def list_for_user(db: AsyncSession, user_id: int) -> Sequence[Book]:
    return (
        await db.scalars(
            select(Book)
            .where(Book.user_id == user_id)
            .order_by(Book.created_at.desc())
        )
    ).all()


async def get_for_user(db: AsyncSession, user_id: int, book_id: int) -> Book | None:
    return await db.scalar(
        select(Book).where(Book.id == book_id, Book.user_id == user_id)
    )


async def delete(db: AsyncSession, book: Book) -> None:
    await db.delete(book)
    await db.commit()