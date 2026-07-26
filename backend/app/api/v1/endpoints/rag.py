"""Book RAG endpoints: activate, reprocess, status, query."""

from fastapi import APIRouter

from app.api.deps import CurrentUser, DbSession
from app.schemas.rag import (
    RagActivateResponse,
    RagQueryRequest,
    RagQueryResponse,
    RagStatusResponse,
)
from app.services import rag_service

router = APIRouter(prefix="/books/{book_id}/rag", tags=["rag"])


@router.post("/activate", response_model=RagActivateResponse, status_code=202)
async def activate_rag(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
) -> RagActivateResponse:
    doc = await rag_service.activate(db, user_id=current_user.id, book_id=book_id)
    return RagActivateResponse(
        document_id=doc.id,
        book_id=doc.book_id,
        status=doc.status,
        message="RAG indexing enqueued",
    )


@router.post("/reprocess", response_model=RagActivateResponse, status_code=202)
async def reprocess_rag(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
) -> RagActivateResponse:
    doc = await rag_service.reprocess(db, user_id=current_user.id, book_id=book_id)
    return RagActivateResponse(
        document_id=doc.id,
        book_id=doc.book_id,
        status=doc.status,
        message="RAG reindex enqueued",
    )


@router.get("/status", response_model=RagStatusResponse)
async def rag_status(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
) -> RagStatusResponse:
    return await rag_service.get_status(
        db, user_id=current_user.id, book_id=book_id
    )


@router.post("/query", response_model=RagQueryResponse)
async def rag_query(
    book_id: int,
    body: RagQueryRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> RagQueryResponse:
    return await rag_service.query(
        db,
        user_id=current_user.id,
        book_id=book_id,
        question=body.question,
        top_k=body.top_k,
    )
