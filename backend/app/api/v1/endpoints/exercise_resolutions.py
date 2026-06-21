import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import CurrentUser, DbSession
from app.crud import book as book_crud
from app.crud import exercise_resolution as crud
from app.models.book import Book
from app.schemas.exercise_resolution import (
    ExerciseAIRequest,
    ExerciseAttemptRead,
    ExerciseResolutionCreate,
    ExerciseResolutionRead,
    ExerciseResolutionUpdate,
)
from app.services import ai
from app.services.storage import storage

router = APIRouter(
    prefix="/books/{book_id}/exercise-resolutions", tags=["exercise-resolutions"]
)


def _sse(event: str, data: dict) -> str:
    # data is always JSON so Markdown newlines never break SSE framing.
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _require_book(db: DbSession, user_id: int, book_id: int) -> Book:
    book = await book_crud.get_for_user(db, user_id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")
    return book


async def _require_resolution(
    db: DbSession, *, user_id: int, book_id: int, resolution_id: int
):
    resolution = await crud.get_for_user(
        db, resolution_id=resolution_id, book_id=book_id, user_id=user_id
    )
    if resolution is None:
        raise HTTPException(404, "Exercise resolution not found")
    return resolution


@router.get("", response_model=list[ExerciseResolutionRead])
async def list_exercise_resolutions(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[ExerciseResolutionRead]:
    await _require_book(db, current_user.id, book_id)
    items = await crud.list_for_book(db, book_id=book_id, user_id=current_user.id)
    return [ExerciseResolutionRead.model_validate(i) for i in items]


@router.post("", response_model=ExerciseResolutionRead, status_code=201)
async def create_exercise_resolution(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: ExerciseResolutionCreate,
) -> ExerciseResolutionRead:
    book = await _require_book(db, current_user.id, book_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "Title cannot be empty")
    if book.page_count is not None and payload.page > book.page_count:
        raise HTTPException(422, "Page is out of range")
    resolution = await crud.create(
        db,
        book_id=book_id,
        user_id=current_user.id,
        title=title,
        page=payload.page,
        region=payload.region.model_dump(),
        statement=payload.statement,
        latex_content=payload.latex_content,
        sketch_content=payload.sketch_content,
    )
    return ExerciseResolutionRead.model_validate(resolution)


@router.get("/{resolution_id}", response_model=ExerciseResolutionRead)
async def get_exercise_resolution(
    book_id: int, resolution_id: int, current_user: CurrentUser, db: DbSession
) -> ExerciseResolutionRead:
    await _require_book(db, current_user.id, book_id)
    resolution = await _require_resolution(
        db, user_id=current_user.id, book_id=book_id, resolution_id=resolution_id
    )
    return ExerciseResolutionRead.model_validate(resolution)


@router.patch("/{resolution_id}", response_model=ExerciseResolutionRead)
async def update_exercise_resolution(
    book_id: int,
    resolution_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: ExerciseResolutionUpdate,
) -> ExerciseResolutionRead:
    await _require_book(db, current_user.id, book_id)
    resolution = await _require_resolution(
        db, user_id=current_user.id, book_id=book_id, resolution_id=resolution_id
    )

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "Title cannot be empty")
        new_title = payload.title.strip()

    resolution = await crud.update(
        db,
        resolution,
        title=new_title,
        statement=payload.statement if "statement" in fields else None,
        latex_content=payload.latex_content if "latex_content" in fields else None,
        sketch_content=payload.sketch_content if "sketch_content" in fields else None,
        status=payload.status if "status" in fields else None,
        ai_feedback=payload.ai_feedback,
        set_ai_feedback="ai_feedback" in fields,
    )
    return ExerciseResolutionRead.model_validate(resolution)


@router.delete("/{resolution_id}", status_code=204)
async def delete_exercise_resolution(
    book_id: int, resolution_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    resolution = await _require_resolution(
        db, user_id=current_user.id, book_id=book_id, resolution_id=resolution_id
    )
    await crud.delete(db, resolution)


@router.get("/{resolution_id}/attempts", response_model=list[ExerciseAttemptRead])
async def list_exercise_attempts(
    book_id: int, resolution_id: int, current_user: CurrentUser, db: DbSession
) -> list[ExerciseAttemptRead]:
    await _require_book(db, current_user.id, book_id)
    await _require_resolution(
        db, user_id=current_user.id, book_id=book_id, resolution_id=resolution_id
    )
    attempts = await crud.list_attempts(
        db, resolution_id=resolution_id, user_id=current_user.id
    )
    return [ExerciseAttemptRead.model_validate(a) for a in attempts]


@router.post(
    "/{resolution_id}/attempts",
    response_model=ExerciseAttemptRead,
    status_code=201,
)
async def create_exercise_attempt(
    book_id: int, resolution_id: int, current_user: CurrentUser, db: DbSession
) -> ExerciseAttemptRead:
    await _require_book(db, current_user.id, book_id)
    resolution = await _require_resolution(
        db, user_id=current_user.id, book_id=book_id, resolution_id=resolution_id
    )
    attempt = await crud.create_attempt(db, resolution)
    return ExerciseAttemptRead.model_validate(attempt)


@router.post("/{resolution_id}/ai")
async def exercise_resolution_ai(
    book_id: int,
    resolution_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: ExerciseAIRequest,
) -> StreamingResponse:
    book = await _require_book(db, current_user.id, book_id)
    resolution = await _require_resolution(
        db, user_id=current_user.id, book_id=book_id, resolution_id=resolution_id
    )
    if not ai.configured():
        raise HTTPException(503, "AI is not configured. Set GEMINI_API_KEY.")
    if book.file_format != "pdf":
        raise HTTPException(400, "Only PDF books support the AI study assistant.")

    data = await storage.read_bytes(book.object_key)
    gemini = ai.client()
    pdf = await ai.extract_pages(data, resolution.page, resolution.page)
    part = ai.inline_part(pdf)
    mode = payload.mode
    statement = resolution.statement
    work = resolution.latex_content
    question = payload.question

    async def event_stream() -> AsyncIterator[str]:
        answer: list[str] = []
        try:
            async for channel, text in ai.stream_exercise_reply(
                gemini,
                part,
                mode=mode,
                statement=statement,
                work=work,
                question=question,
            ):
                if channel == "thinking":
                    yield _sse("thinking", {"text": text})
                else:
                    answer.append(text)
                    yield _sse("delta", {"text": text})
            content = "".join(answer).strip() or "_No response generated._"
            yield _sse("done", {"mode": mode, "content": content})
        except Exception:
            yield _sse("error", {"detail": "The AI request failed. Please try again."})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
