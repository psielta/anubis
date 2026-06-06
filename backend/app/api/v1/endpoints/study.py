import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.crud import book as book_crud
from app.crud import study as study_crud
from app.schemas.study import StudyMessageRead, StudyRequest
from app.services import ai
from app.services.storage import storage

router = APIRouter(prefix="/books/{book_id}/study", tags=["study"])

_GEMINI_PDF_LIMIT = 50 * 1024 * 1024


def _sse(event: str, data: dict) -> str:
    # data is always JSON so Markdown newlines never break SSE framing.
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("", response_model=list[StudyMessageRead])
async def list_study_messages(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[StudyMessageRead]:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")
    messages = await study_crud.list_for_book(db, book.id)
    return [StudyMessageRead.model_validate(m) for m in messages]


@router.delete("", status_code=204)
async def clear_study_messages(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")
    await study_crud.clear_for_book(db, book.id)


@router.post("")
async def create_study_message(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: StudyRequest,
) -> StreamingResponse:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Book not found")
    if not ai.configured():
        raise HTTPException(503, "AI is not configured. Set GEMINI_API_KEY.")
    if book.file_format != "pdf":
        raise HTTPException(400, "Only PDF books support the AI study assistant.")

    data = await storage.read_bytes(book.object_key)
    gemini = ai.client()

    # Resolve the PDF part to send and a human-readable scope label.
    if payload.scope == "chapter" and payload.page_from and payload.page_to:
        pdf = await ai.extract_pages(data, payload.page_from, payload.page_to)
        part = ai.inline_part(pdf)
        scope = f"pp. {payload.page_from}–{payload.page_to}"
    else:
        scope = "Whole book"
        size = book.file_size or len(data)
        if size <= settings.AI_INLINE_MAX_MB * 1024 * 1024:
            part = ai.inline_part(data)
        elif size <= _GEMINI_PDF_LIMIT:
            name = study_crud.valid_ai_file(book)
            cached = await ai.get_file(gemini, name) if name else None
            if cached is None:
                cached = await ai.upload_pdf(gemini, data, book.id)
                await study_crud.set_ai_file(db, book, name=cached.name)
            part = cached
        else:
            raise HTTPException(
                413, "Book too large for whole-book AI — choose a chapter instead."
            )

    if payload.kind == "chat":
        if payload.selection:
            excerpt = payload.selection.strip()
            if len(excerpt) > 280:
                excerpt = excerpt[:280] + "…"
            user_content = f"“{excerpt}”\n\n{(payload.question or '').strip()}"
            user_scope = "Selection"
        else:
            user_content = (payload.question or "").strip()
            user_scope = scope
        await study_crud.add_message(
            db,
            book_id=book.id,
            user_id=current_user.id,
            role="user",
            kind="chat",
            content=user_content,
            scope=user_scope,
        )

    async def event_stream() -> AsyncIterator[str]:
        answer: list[str] = []
        try:
            async for channel, text in ai.stream_reply(
                gemini, part, payload.kind, payload.question, payload.selection
            ):
                if channel == "thinking":
                    yield _sse("thinking", {"text": text})
                else:
                    answer.append(text)
                    yield _sse("delta", {"text": text})
            content = "".join(answer).strip() or "_No response generated._"
            message = await study_crud.add_message(
                db,
                book_id=book.id,
                user_id=current_user.id,
                role="assistant",
                kind=payload.kind,
                content=content,
                scope=scope,
            )
            yield _sse("done", {"id": message.id, "scope": scope, "kind": payload.kind})
        except Exception:
            yield _sse("error", {"detail": "The AI request failed. Please try again."})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
