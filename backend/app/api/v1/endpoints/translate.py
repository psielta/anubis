import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.crud import book as book_crud
from app.crud import translation as translation_crud
from app.schemas.translation import TranslationRead, TranslationRequest
from app.services import ai
from app.services.storage import storage

router = APIRouter(prefix="/books/{book_id}/translate", tags=["translate"])

_TARGET_LANG = "pt-BR"


def _sse(event: str, data: dict) -> str:
    # data is always JSON so Markdown newlines never break SSE framing.
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _stream_response(gen: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        gen,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{page}", response_model=TranslationRead)
async def get_cached_translation(
    book_id: int, page: int, current_user: CurrentUser, db: DbSession
) -> TranslationRead:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Livro não encontrado")
    cached = await translation_crud.get(db, book.id, page, _TARGET_LANG)
    if cached is None:
        raise HTTPException(404, "Nenhuma tradução para esta página")
    return TranslationRead.model_validate(cached)


@router.post("")
async def translate_page(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: TranslationRequest,
) -> StreamingResponse:
    book = await book_crud.get_for_user(db, current_user.id, book_id)
    if book is None:
        raise HTTPException(404, "Livro não encontrado")
    if not ai.configured():
        raise HTTPException(503, "IA não configurada. Defina GEMINI_API_KEY.")
    if book.file_format != "pdf":
        raise HTTPException(400, "Apenas livros em PDF suportam tradução de página.")
    if book.page_count and payload.page > book.page_count:
        raise HTTPException(422, "Página fora do intervalo.")

    page = payload.page

    # Serve a cached translation instantly as a single SSE frame.
    if not payload.force:
        cached = await translation_crud.get(db, book.id, page, _TARGET_LANG)
        if cached is not None:
            markdown = cached.markdown
            model = cached.model

            async def cached_stream() -> AsyncIterator[str]:
                yield _sse("delta", {"text": markdown})
                yield _sse("done", {"page": page, "cached": True, "model": model})

            return _stream_response(cached_stream())

    data = await storage.read_bytes(book.object_key)
    pdf = await ai.extract_pages(data, page, page)
    part = ai.inline_part(pdf)
    gemini = ai.client()

    async def event_stream() -> AsyncIterator[str]:
        chunks: list[str] = []
        try:
            async for text in ai.stream_translation(gemini, part):
                chunks.append(text)
                yield _sse("delta", {"text": text})
            content = "".join(chunks).strip() or "_Sem conteúdo._"
            await translation_crud.upsert(
                db,
                book_id=book.id,
                page=page,
                lang=_TARGET_LANG,
                markdown=content,
                model=settings.GEMINI_MODEL,
            )
            yield _sse(
                "done", {"page": page, "cached": False, "model": settings.GEMINI_MODEL}
            )
        except Exception:
            yield _sse("error", {"detail": "A tradução falhou. Tente novamente."})

    return _stream_response(event_stream())
