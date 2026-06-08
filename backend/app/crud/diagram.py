from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.diagram import Diagram


async def list_for_book(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[Diagram]:
    return (
        await db.scalars(
            select(Diagram)
            .where(Diagram.book_id == book_id, Diagram.user_id == user_id)
            .order_by(Diagram.updated_at.desc(), Diagram.id.desc())
        )
    ).all()


async def get_for_user(
    db: AsyncSession, *, diagram_id: int, book_id: int, user_id: int
) -> Diagram | None:
    return await db.scalar(
        select(Diagram).where(
            Diagram.id == diagram_id,
            Diagram.book_id == book_id,
            Diagram.user_id == user_id,
        )
    )


async def create(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    title: str,
    type: str,
    content: str,
    page: int | None,
) -> Diagram:
    diagram = Diagram(
        book_id=book_id,
        user_id=user_id,
        title=title,
        type=type,
        content=content,
        page=page,
    )
    db.add(diagram)
    await db.commit()
    await db.refresh(diagram)
    return diagram


async def update(
    db: AsyncSession,
    diagram: Diagram,
    *,
    title: str | None = None,
    content: str | None = None,
    page: int | None = None,
    set_page: bool = False,
) -> Diagram:
    """Patch a diagram. ``title``/``content`` are applied only when not None;
    ``page`` is applied (including to None, to clear it) only when ``set_page``."""
    if title is not None:
        diagram.title = title
    if content is not None:
        diagram.content = content
    if set_page:
        diagram.page = page
    await db.commit()
    await db.refresh(diagram)
    return diagram


async def delete(db: AsyncSession, diagram: Diagram) -> None:
    await db.delete(diagram)
    await db.commit()
