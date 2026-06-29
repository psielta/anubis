from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.word_document import WordDocument


async def list_documents(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[WordDocument]:
    return (
        await db.scalars(
            select(WordDocument)
            .where(
                WordDocument.book_id == book_id,
                WordDocument.user_id == user_id,
            )
            .order_by(WordDocument.updated_at.desc(), WordDocument.id.desc())
        )
    ).all()


async def get_document_for_user(
    db: AsyncSession, *, document_id: int, book_id: int, user_id: int
) -> WordDocument | None:
    return await db.scalar(
        select(WordDocument).where(
            WordDocument.id == document_id,
            WordDocument.book_id == book_id,
            WordDocument.user_id == user_id,
        )
    )


async def create_document(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    title: str,
    page: int | None,
    object_key: str,
    file_size: int,
    content_type: str,
) -> WordDocument:
    document = WordDocument(
        book_id=book_id,
        user_id=user_id,
        title=title,
        page=page,
        object_key=object_key,
        file_size=file_size,
        content_type=content_type,
    )
    db.add(document)
    await db.commit()
    await db.refresh(document)
    return document


async def update_document(
    db: AsyncSession,
    document: WordDocument,
    *,
    title: str | None = None,
    page: int | None = None,
    set_page: bool = False,
) -> WordDocument:
    if title is not None:
        document.title = title
    if set_page:
        document.page = page
    await db.commit()
    await db.refresh(document)
    return document


async def mark_document_saved(
    db: AsyncSession,
    document: WordDocument,
    *,
    file_size: int,
) -> WordDocument:
    document.file_size = file_size
    document.revision += 1
    document.last_saved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(document)
    return document


async def delete_document(db: AsyncSession, document: WordDocument) -> None:
    await db.delete(document)
    await db.commit()
