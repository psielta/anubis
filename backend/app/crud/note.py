from collections.abc import Sequence

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note import Note


async def list_for_book(
    db: AsyncSession, *, book_id: int, user_id: int, query: str | None = None
) -> Sequence[Note]:
    stmt = (
        select(Note)
        .where(Note.book_id == book_id, Note.user_id == user_id)
        .order_by(Note.updated_at.desc(), Note.id.desc())
    )
    if query:
        # Escape LIKE wildcards so a search for "100%" matches literally.
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        stmt = stmt.where(
            or_(
                Note.title.ilike(pattern, escape="\\"),
                Note.content.ilike(pattern, escape="\\"),
            )
        )
    return (await db.scalars(stmt)).all()


async def get_for_user(
    db: AsyncSession, *, note_id: int, book_id: int, user_id: int
) -> Note | None:
    return await db.scalar(
        select(Note).where(
            Note.id == note_id,
            Note.book_id == book_id,
            Note.user_id == user_id,
        )
    )


async def create(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    title: str,
    content: str,
    page: int | None,
) -> Note:
    note = Note(
        book_id=book_id,
        user_id=user_id,
        title=title,
        content=content,
        page=page,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


async def update(
    db: AsyncSession,
    note: Note,
    *,
    title: str | None = None,
    content: str | None = None,
    page: int | None = None,
    set_page: bool = False,
) -> Note:
    """Patch a note. ``title``/``content`` are applied only when not None;
    ``page`` is applied (including to None, to clear it) only when ``set_page``."""
    if title is not None:
        note.title = title
    if content is not None:
        note.content = content
    if set_page:
        note.page = page
    await db.commit()
    await db.refresh(note)
    return note


async def delete(db: AsyncSession, note: Note) -> None:
    await db.delete(note)
    await db.commit()
