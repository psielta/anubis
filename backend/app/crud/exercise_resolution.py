from collections.abc import Sequence

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.exercise_resolution import (
    ExerciseAttempt,
    ExerciseChatMessage,
    ExerciseResolution,
)


async def list_for_book(
    db: AsyncSession, *, book_id: int, user_id: int
) -> Sequence[ExerciseResolution]:
    return (
        await db.scalars(
            select(ExerciseResolution)
            .where(
                ExerciseResolution.book_id == book_id,
                ExerciseResolution.user_id == user_id,
            )
            .order_by(
                ExerciseResolution.page.asc(),
                ExerciseResolution.updated_at.desc(),
                ExerciseResolution.id.desc(),
            )
        )
    ).all()


async def get_for_user(
    db: AsyncSession, *, resolution_id: int, book_id: int, user_id: int
) -> ExerciseResolution | None:
    return await db.scalar(
        select(ExerciseResolution).where(
            ExerciseResolution.id == resolution_id,
            ExerciseResolution.book_id == book_id,
            ExerciseResolution.user_id == user_id,
        )
    )


async def create(
    db: AsyncSession,
    *,
    book_id: int,
    user_id: int,
    title: str,
    page: int,
    region: dict[str, float],
    statement: str,
    latex_content: str,
    sketch_content: str,
) -> ExerciseResolution:
    resolution = ExerciseResolution(
        book_id=book_id,
        user_id=user_id,
        title=title,
        page=page,
        region=region,
        statement=statement,
        latex_content=latex_content,
        sketch_content=sketch_content,
    )
    db.add(resolution)
    await db.commit()
    await db.refresh(resolution)
    return resolution


async def update(
    db: AsyncSession,
    resolution: ExerciseResolution,
    *,
    title: str | None = None,
    statement: str | None = None,
    latex_content: str | None = None,
    sketch_content: str | None = None,
    status: str | None = None,
    ai_feedback: str | None = None,
    set_ai_feedback: bool = False,
) -> ExerciseResolution:
    if title is not None:
        resolution.title = title
    if statement is not None:
        resolution.statement = statement
    if latex_content is not None:
        resolution.latex_content = latex_content
    if sketch_content is not None:
        resolution.sketch_content = sketch_content
    if status is not None:
        resolution.status = status
    if set_ai_feedback:
        resolution.ai_feedback = ai_feedback
    await db.commit()
    await db.refresh(resolution)
    return resolution


async def delete(db: AsyncSession, resolution: ExerciseResolution) -> None:
    await db.delete(resolution)
    await db.commit()


async def list_attempts(
    db: AsyncSession, *, resolution_id: int, user_id: int
) -> Sequence[ExerciseAttempt]:
    return (
        await db.scalars(
            select(ExerciseAttempt)
            .where(
                ExerciseAttempt.resolution_id == resolution_id,
                ExerciseAttempt.user_id == user_id,
            )
            .order_by(ExerciseAttempt.created_at.desc(), ExerciseAttempt.id.desc())
        )
    ).all()


async def create_attempt(
    db: AsyncSession, resolution: ExerciseResolution
) -> ExerciseAttempt:
    """Snapshot the resolution's current working state into the attempt history."""
    attempt = ExerciseAttempt(
        resolution_id=resolution.id,
        user_id=resolution.user_id,
        latex_content=resolution.latex_content,
        sketch_content=resolution.sketch_content,
        ai_feedback=resolution.ai_feedback,
    )
    db.add(attempt)
    await db.commit()
    await db.refresh(attempt)
    return attempt


async def list_chat(
    db: AsyncSession, *, resolution_id: int
) -> Sequence[ExerciseChatMessage]:
    return (
        await db.scalars(
            select(ExerciseChatMessage)
            .where(ExerciseChatMessage.resolution_id == resolution_id)
            .order_by(ExerciseChatMessage.created_at.asc(), ExerciseChatMessage.id.asc())
        )
    ).all()


async def add_chat_message(
    db: AsyncSession, *, resolution_id: int, role: str, content: str
) -> ExerciseChatMessage:
    message = ExerciseChatMessage(
        resolution_id=resolution_id, role=role, content=content
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)
    return message


async def clear_chat(db: AsyncSession, *, resolution_id: int) -> None:
    await db.execute(
        sql_delete(ExerciseChatMessage).where(
            ExerciseChatMessage.resolution_id == resolution_id
        )
    )
    await db.commit()
