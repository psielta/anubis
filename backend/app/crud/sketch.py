from collections.abc import Sequence

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sketch import Sketch, SketchGroup


async def list_groups(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[SketchGroup]:
    return (
        await db.scalars(
            select(SketchGroup)
            .where(SketchGroup.book_id == book_id, SketchGroup.user_id == user_id)
            .order_by(SketchGroup.position.asc(), SketchGroup.id.asc())
        )
    ).all()


async def get_group_for_user(
    db: AsyncSession, *, group_id: int, book_id: int, user_id: int
) -> SketchGroup | None:
    return await db.scalar(
        select(SketchGroup).where(
            SketchGroup.id == group_id,
            SketchGroup.book_id == book_id,
            SketchGroup.user_id == user_id,
        )
    )


async def create_group(
    db: AsyncSession, *, book_id: int, user_id: int, name: str
) -> SketchGroup:
    max_position = await db.scalar(
        select(func.max(SketchGroup.position)).where(
            SketchGroup.book_id == book_id,
            SketchGroup.user_id == user_id,
        )
    )
    group = SketchGroup(
        book_id=book_id,
        user_id=user_id,
        name=name,
        position=(max_position or 0) + 1,
    )
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return group


async def update_group(
    db: AsyncSession,
    group: SketchGroup,
    *,
    name: str | None = None,
    position: int | None = None,
) -> SketchGroup:
    if name is not None:
        group.name = name
    if position is not None:
        group.position = position
    await db.commit()
    await db.refresh(group)
    return group


async def delete_group(db: AsyncSession, group: SketchGroup) -> None:
    await db.execute(
        update(Sketch)
        .where(
            Sketch.book_id == group.book_id,
            Sketch.user_id == group.user_id,
            Sketch.group_id == group.id,
        )
        .values(group_id=None)
    )
    await db.delete(group)
    await db.commit()


async def list_sketches(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[Sketch]:
    return (
        await db.scalars(
            select(Sketch)
            .where(Sketch.book_id == book_id, Sketch.user_id == user_id)
            .order_by(Sketch.updated_at.desc(), Sketch.id.desc())
        )
    ).all()


async def get_sketch_for_user(
    db: AsyncSession, *, sketch_id: int, book_id: int, user_id: int
) -> Sketch | None:
    return await db.scalar(
        select(Sketch).where(
            Sketch.id == sketch_id,
            Sketch.book_id == book_id,
            Sketch.user_id == user_id,
        )
    )


async def create_sketch(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    title: str,
    content: str,
    group_id: int | None,
    page: int | None,
) -> Sketch:
    sketch = Sketch(
        book_id=book_id,
        user_id=user_id,
        title=title,
        content=content,
        group_id=group_id,
        page=page,
    )
    db.add(sketch)
    await db.commit()
    await db.refresh(sketch)
    return sketch


async def update_sketch(
    db: AsyncSession,
    sketch: Sketch,
    *,
    title: str | None = None,
    content: str | None = None,
    group_id: int | None = None,
    set_group: bool = False,
    page: int | None = None,
    set_page: bool = False,
) -> Sketch:
    if title is not None:
        sketch.title = title
    if content is not None:
        sketch.content = content
    if set_group:
        sketch.group_id = group_id
    if set_page:
        sketch.page = page
    await db.commit()
    await db.refresh(sketch)
    return sketch


async def delete_sketch(db: AsyncSession, sketch: Sketch) -> None:
    await db.delete(sketch)
    await db.commit()
