from collections.abc import Sequence

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.latex_notebook import LatexNotebook, LatexNotebookGroup


async def list_groups(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[LatexNotebookGroup]:
    return (
        await db.scalars(
            select(LatexNotebookGroup)
            .where(
                LatexNotebookGroup.book_id == book_id,
                LatexNotebookGroup.user_id == user_id,
            )
            .order_by(
                LatexNotebookGroup.position.asc(), LatexNotebookGroup.id.asc()
            )
        )
    ).all()


async def get_group_for_user(
    db: AsyncSession, *, group_id: int, book_id: int, user_id: int
) -> LatexNotebookGroup | None:
    return await db.scalar(
        select(LatexNotebookGroup).where(
            LatexNotebookGroup.id == group_id,
            LatexNotebookGroup.book_id == book_id,
            LatexNotebookGroup.user_id == user_id,
        )
    )


async def create_group(
    db: AsyncSession, *, book_id: int, user_id: int, name: str
) -> LatexNotebookGroup:
    max_position = await db.scalar(
        select(func.max(LatexNotebookGroup.position)).where(
            LatexNotebookGroup.book_id == book_id,
            LatexNotebookGroup.user_id == user_id,
        )
    )
    group = LatexNotebookGroup(
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
    group: LatexNotebookGroup,
    *,
    name: str | None = None,
    position: int | None = None,
) -> LatexNotebookGroup:
    if name is not None:
        group.name = name
    if position is not None:
        group.position = position
    await db.commit()
    await db.refresh(group)
    return group


async def delete_group(db: AsyncSession, group: LatexNotebookGroup) -> None:
    await db.execute(
        update(LatexNotebook)
        .where(
            LatexNotebook.book_id == group.book_id,
            LatexNotebook.user_id == group.user_id,
            LatexNotebook.group_id == group.id,
        )
        .values(group_id=None)
    )
    await db.delete(group)
    await db.commit()


async def list_notebooks(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[LatexNotebook]:
    return (
        await db.scalars(
            select(LatexNotebook)
            .where(
                LatexNotebook.book_id == book_id,
                LatexNotebook.user_id == user_id,
            )
            .order_by(LatexNotebook.updated_at.desc(), LatexNotebook.id.desc())
        )
    ).all()


async def get_notebook_for_user(
    db: AsyncSession, *, notebook_id: int, book_id: int, user_id: int
) -> LatexNotebook | None:
    return await db.scalar(
        select(LatexNotebook).where(
            LatexNotebook.id == notebook_id,
            LatexNotebook.book_id == book_id,
            LatexNotebook.user_id == user_id,
        )
    )


async def create_notebook(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    title: str,
    content: str,
    group_id: int | None,
    page: int | None,
) -> LatexNotebook:
    notebook = LatexNotebook(
        book_id=book_id,
        user_id=user_id,
        title=title,
        content=content,
        group_id=group_id,
        page=page,
    )
    db.add(notebook)
    await db.commit()
    await db.refresh(notebook)
    return notebook


async def update_notebook(
    db: AsyncSession,
    notebook: LatexNotebook,
    *,
    title: str | None = None,
    content: str | None = None,
    group_id: int | None = None,
    set_group: bool = False,
    page: int | None = None,
    set_page: bool = False,
) -> LatexNotebook:
    if title is not None:
        notebook.title = title
    if content is not None:
        notebook.content = content
    if set_group:
        notebook.group_id = group_id
    if set_page:
        notebook.page = page
    await db.commit()
    await db.refresh(notebook)
    return notebook


async def delete_notebook(db: AsyncSession, notebook: LatexNotebook) -> None:
    await db.delete(notebook)
    await db.commit()
