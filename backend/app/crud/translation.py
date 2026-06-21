from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.translation import PageTranslation


async def get(
    db: AsyncSession, book_id: int, page: int, lang: str = "pt-BR"
) -> PageTranslation | None:
    return await db.scalar(
        select(PageTranslation).where(
            PageTranslation.book_id == book_id,
            PageTranslation.page == page,
            PageTranslation.lang == lang,
        )
    )


async def upsert(
    db: AsyncSession,
    *,
    book_id: int,
    page: int,
    lang: str,
    markdown: str,
    model: str,
) -> PageTranslation:
    existing = await get(db, book_id, page, lang)
    if existing is not None:
        existing.markdown = markdown
        existing.model = model
        await db.commit()
        await db.refresh(existing)
        return existing

    row = PageTranslation(
        book_id=book_id, page=page, lang=lang, markdown=markdown, model=model
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
