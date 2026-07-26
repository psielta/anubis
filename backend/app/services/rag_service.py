"""HTTP-facing RAG lifecycle: activate, reprocess, status, query."""

from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.crud import book as book_crud
from app.crud import outbox as outbox_crud
from app.crud import rag as rag_crud
from app.models.outbox import OutboxEventType
from app.models.rag import RagDocument, RagStatus
from app.schemas.rag import (
    RagQueryResponse,
    RagSource,
    RagStatusResponse,
)
from google.genai import types

from app.services import ai as ai_service
from app.services import gemini_embeddings, rag_chunking

logger = logging.getLogger(__name__)

_RAG_ANSWER_SYSTEM = (
    "Você é um assistente de estudos. Responda APENAS com base nos trechos "
    "fornecidos do livro. Se a resposta não estiver nos trechos, diga isso "
    "claramente. Cite as fontes usando [Fonte N] e mencione o número da página "
    "quando disponível. Responda em português do Brasil, em Markdown claro."
)


async def _owned_book(db: AsyncSession, user_id: int, book_id: int):
    book = await book_crud.get_for_user(db, user_id, book_id)
    if book is None:
        raise HTTPException(404, "Livro não encontrado")
    if (book.file_format or "").lower() != "pdf":
        raise HTTPException(415, "RAG está disponível apenas para livros PDF")
    return book


def _status_response(doc: RagDocument) -> RagStatusResponse:
    return RagStatusResponse.model_validate(doc)


async def activate(
    db: AsyncSession, *, user_id: int, book_id: int
) -> RagDocument:
    """Enqueue RAG indexing for a book (async; no heavy work in request)."""
    book = await _owned_book(db, user_id, book_id)
    existing = await rag_crud.get_document_by_book(db, book_id)
    if existing is not None:
        if existing.status in (
            RagStatus.PENDING.value,
            RagStatus.PROCESSING.value,
        ):
            return existing
        if existing.status == RagStatus.COMPLETED.value:
            raise HTTPException(
                409,
                "RAG já está ativo para este livro; use reprocessar para reindexar",
            )
        # failed → allow re-activate by resetting
        await rag_crud.reset_for_reprocess(
            db, existing, page_count=book.page_count
        )
        await outbox_crud.enqueue(
            db,
            aggregate_id=existing.id,
            event_type=OutboxEventType.RAG_INDEX_REQUESTED,
            payload={"book_id": book_id, "document_id": str(existing.id)},
            max_attempts=settings.RAG_OUTBOX_MAX_ATTEMPTS,
        )
        await db.commit()
        await db.refresh(existing)
        return existing

    doc = await rag_crud.create_document(
        db,
        book_id=book_id,
        owner_id=user_id,
        page_count=book.page_count,
    )
    await outbox_crud.enqueue(
        db,
        aggregate_id=doc.id,
        event_type=OutboxEventType.RAG_INDEX_REQUESTED,
        payload={"book_id": book_id, "document_id": str(doc.id)},
        max_attempts=settings.RAG_OUTBOX_MAX_ATTEMPTS,
    )
    await db.commit()
    await db.refresh(doc)
    return doc


async def reprocess(
    db: AsyncSession, *, user_id: int, book_id: int
) -> RagDocument:
    """Force re-index: clear vectors, status→pending, enqueue outbox event."""
    book = await _owned_book(db, user_id, book_id)
    doc = await rag_crud.get_document_for_owner(
        db, owner_id=user_id, book_id=book_id
    )
    if doc is None:
        # First-time: same as activate
        return await activate(db, user_id=user_id, book_id=book_id)

    if doc.status == RagStatus.PROCESSING.value:
        raise HTTPException(409, "Indexação RAG já em andamento")

    await rag_crud.reset_for_reprocess(db, doc, page_count=book.page_count)
    await outbox_crud.enqueue(
        db,
        aggregate_id=doc.id,
        event_type=OutboxEventType.RAG_REINDEX_REQUESTED,
        payload={"book_id": book_id, "document_id": str(doc.id)},
        max_attempts=settings.RAG_OUTBOX_MAX_ATTEMPTS,
    )
    await db.commit()
    await db.refresh(doc)
    return doc


async def get_status(
    db: AsyncSession, *, user_id: int, book_id: int
) -> RagStatusResponse:
    await _owned_book(db, user_id, book_id)
    doc = await rag_crud.get_document_for_owner(
        db, owner_id=user_id, book_id=book_id
    )
    if doc is None:
        raise HTTPException(404, "RAG ainda não foi ativado para este livro")
    return _status_response(doc)


async def query(
    db: AsyncSession,
    *,
    user_id: int,
    book_id: int,
    question: str,
    top_k: int = 5,
) -> RagQueryResponse:
    """Answer from the populated vector store only (no re-index)."""
    await _owned_book(db, user_id, book_id)
    doc = await rag_crud.get_document_for_owner(
        db, owner_id=user_id, book_id=book_id
    )
    if doc is None:
        raise HTTPException(404, "RAG ainda não foi ativado para este livro")
    if doc.status != RagStatus.COMPLETED.value:
        raise HTTPException(
            409,
            f"RAG não está pronto (status={doc.status}); aguarde a indexação",
        )
    if doc.chunk_count <= 0:
        raise HTTPException(409, "Índice RAG vazio; reprocesse o livro")

    if not gemini_embeddings.configured():
        raise HTTPException(503, "GEMINI_API_KEY não configurada")

    q = question.strip()
    if not q:
        raise HTTPException(422, "Pergunta vazia")

    query_vec = await gemini_embeddings.embed_query(q)
    hits = await rag_crud.similarity_search(
        db, book_id=book_id, query_embedding=query_vec, top_k=top_k
    )
    if not hits:
        raise HTTPException(404, "Nenhum trecho encontrado no índice deste livro")

    context_hits = [
        (chunk.content, chunk.page_start, chunk.page_end, chunk.title)
        for chunk, _score in hits
    ]
    context = rag_chunking.build_context_from_chunks(context_hits)
    source_rows: list[tuple[int, int | None, int | None, str, str, float | None]] = [
        (
            chunk.chunk_index,
            chunk.page_start,
            chunk.page_end,
            chunk.title,
            chunk.content,
            score,
        )
        for chunk, score in hits
    ]
    sources_raw = rag_chunking.shape_sources(source_rows)

    answer = await generate_rag_answer(question=q, context=context)
    return RagQueryResponse(
        book_id=book_id,
        question=q,
        answer=answer,
        sources=[RagSource.model_validate(s) for s in sources_raw],
    )


async def generate_rag_answer(*, question: str, context: str) -> str:
    """Call Gemini LLM with retrieved context; pure prompt assembly is testable."""
    prompt = (
        "Trechos recuperados do livro:\n\n"
        f"{context}\n\n"
        f"Pergunta do usuário: {question}\n\n"
        "Responda com base nos trechos acima."
    )
    gemini = ai_service.client()
    config = types.GenerateContentConfig(system_instruction=_RAG_ANSWER_SYSTEM)
    response = await gemini.aio.models.generate_content(
        model=settings.GEMINI_MODEL,
        contents=prompt,
        config=config,
    )
    text = getattr(response, "text", None)
    if text and text.strip():
        return text.strip()
    # Fallback: walk candidates/parts
    candidates = getattr(response, "candidates", None) or []
    parts_out: list[str] = []
    for cand in candidates:
        content = getattr(cand, "content", None)
        if content is None:
            continue
        for part in getattr(content, "parts", None) or []:
            t = getattr(part, "text", None)
            if t:
                parts_out.append(t)
    if parts_out:
        return "".join(parts_out).strip()
    return "Não foi possível gerar uma resposta a partir dos trechos recuperados."
