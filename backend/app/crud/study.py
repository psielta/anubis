from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import Book
from app.models.study import StudyMessage

# Gemini File API uploads live ~48h; cache a little under that.
_AI_FILE_TTL_HOURS = 47


async def list_for_book(db: AsyncSession, book_id: int) -> Sequence[StudyMessage]:
    return (
        await db.scalars(
            select(StudyMessage)
            .where(StudyMessage.book_id == book_id)
            .order_by(StudyMessage.created_at, StudyMessage.id)
        )
    ).all()


async def add_message(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    role: str,
    kind: str,
    content: str,
    scope: str | None = None,
) -> StudyMessage:
    message = StudyMessage(
        book_id=book_id,
        user_id=user_id,
        role=role,
        kind=kind,
        content=content,
        scope=scope,
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)
    return message


async def clear_for_book(db: AsyncSession, book_id: int) -> None:
    await db.execute(delete(StudyMessage).where(StudyMessage.book_id == book_id))
    await db.commit()


def valid_ai_file(book: Book) -> str | None:
    """The cached Gemini file name if it hasn't expired, else None."""
    if (
        book.ai_file_name
        and book.ai_file_expires_at
        and book.ai_file_expires_at > datetime.now(timezone.utc)
    ):
        return book.ai_file_name
    return None


async def set_ai_file(db: AsyncSession, book: Book, *, name: str) -> None:
    book.ai_file_name = name
    book.ai_file_expires_at = datetime.now(timezone.utc) + timedelta(
        hours=_AI_FILE_TTL_HOURS
    )
    await db.commit()
