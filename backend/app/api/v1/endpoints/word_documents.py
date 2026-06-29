from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import httpx
import jwt
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.crud import book as book_crud
from app.crud import word_document as word_crud
from app.models.word_document import WordDocument
from app.schemas.word_document import (
    OnlyOfficeCallback,
    OnlyOfficeEditorConfig,
    WordDocumentCreate,
    WordDocumentRead,
    WordDocumentUpdate,
)
from app.services.docx_template import DOCX_CONTENT_TYPE, blank_docx_bytes
from app.services.storage import storage

router = APIRouter(prefix="/books/{book_id}/word-documents", tags=["word-documents"])
onlyoffice_router = APIRouter(
    prefix="/onlyoffice/word-documents", tags=["word-documents"]
)


async def _require_book(db: DbSession, user_id: int, book_id: int) -> None:
    if await book_crud.get_for_user(db, user_id, book_id) is None:
        raise HTTPException(404, "Livro nao encontrado")


async def _require_document(
    db: DbSession, *, user_id: int, book_id: int, document_id: int
) -> WordDocument:
    document = await word_crud.get_document_for_user(
        db, document_id=document_id, book_id=book_id, user_id=user_id
    )
    if document is None:
        raise HTTPException(404, "Documento Word nao encontrado")
    return document


def _onlyoffice_secret() -> str:
    return settings.ONLYOFFICE_JWT_SECRET or settings.SECRET_KEY


def _safe_filename(name: str) -> str:
    safe = name.replace('"', "_").replace("\\", "_").replace("\r", "_").replace("\n", "_").strip()
    if not safe:
        safe = "documento"
    if not safe.lower().endswith(".docx"):
        safe = f"{safe}.docx"
    return safe


def _public_api_base(request: Request) -> str:
    configured = settings.ONLYOFFICE_CALLBACK_BASE_URL.strip().rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


def _document_key(document: WordDocument) -> str:
    return f"word-{document.id}-{document.revision}"


def _create_access_token(document: WordDocument) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "type": "onlyoffice-word",
        "sub": str(document.user_id),
        "document_id": document.id,
        "book_id": document.book_id,
        "iat": now,
        "exp": now + timedelta(hours=settings.ONLYOFFICE_CALLBACK_TOKEN_HOURS),
    }
    return jwt.encode(payload, _onlyoffice_secret(), algorithm=settings.ALGORITHM)


def _decode_access_token(token: str, document_id: int) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token, _onlyoffice_secret(), algorithms=[settings.ALGORITHM]
        )
    except jwt.PyJWTError:
        raise HTTPException(403, "Token do ONLYOFFICE invalido")

    try:
        payload_document_id = int(payload.get("document_id", 0))
        int(payload.get("sub", 0))
        int(payload.get("book_id", 0))
    except (TypeError, ValueError):
        raise HTTPException(403, "Token do ONLYOFFICE invalido")

    if payload.get("type") != "onlyoffice-word" or payload_document_id != document_id:
        raise HTTPException(403, "Token do ONLYOFFICE invalido")
    return payload


async def _document_from_signed_token(
    db: DbSession, *, document_id: int, token: str
) -> WordDocument:
    payload = _decode_access_token(token, document_id)
    return await _require_document(
        db,
        user_id=int(payload["sub"]),
        book_id=int(payload["book_id"]),
        document_id=document_id,
    )


def _signed_url(request: Request, document: WordDocument, suffix: str) -> str:
    token = _create_access_token(document)
    return (
        f"{_public_api_base(request)}{settings.API_V1_STR}"
        f"/onlyoffice/word-documents/{document.id}/{suffix}?token={token}"
    )


def _editor_config(
    request: Request, document: WordDocument, current_user: Any
) -> OnlyOfficeEditorConfig:
    if not settings.ONLYOFFICE_ENABLED:
        raise HTTPException(503, "Editor Word indisponivel")

    document_server_url = settings.ONLYOFFICE_DOCSERVER_PUBLIC_URL.strip().rstrip("/")
    if not document_server_url:
        raise HTTPException(503, "Servidor ONLYOFFICE nao configurado")

    filename = _safe_filename(document.title)
    config: dict[str, Any] = {
        "document": {
            "fileType": "docx",
            "key": _document_key(document),
            "title": filename,
            "url": _signed_url(request, document, "content"),
            "permissions": {
                "copy": True,
                "download": True,
                "edit": True,
                "print": True,
            },
        },
        "documentType": "word",
        "editorConfig": {
            "callbackUrl": _signed_url(request, document, "callback"),
            "lang": "pt-BR",
            "mode": "edit",
            "user": {
                "id": str(current_user.id),
                "name": current_user.full_name or current_user.email,
            },
        },
        "height": "100%",
        "width": "100%",
    }
    config["token"] = jwt.encode(
        config, _onlyoffice_secret(), algorithm=settings.ALGORITHM
    )
    return OnlyOfficeEditorConfig(
        document_server_url=document_server_url,
        config=config,
    )


def _rewrite_onlyoffice_download_url(url: str) -> str:
    public = settings.ONLYOFFICE_DOCSERVER_PUBLIC_URL.strip().rstrip("/")
    internal = settings.ONLYOFFICE_DOCSERVER_INTERNAL_URL.strip().rstrip("/")
    if public and internal and url.startswith(public):
        return f"{internal}{url[len(public):]}"
    return url


async def _download_edited_docx(url: str) -> bytes:
    download_url = _rewrite_onlyoffice_download_url(url)
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
            response = await client.get(download_url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RuntimeError("ONLYOFFICE edited document download failed") from exc

    data = response.content
    max_bytes = settings.ONLYOFFICE_MAX_DOCX_MB * 1024 * 1024
    if len(data) > max_bytes:
        raise RuntimeError("ONLYOFFICE edited document exceeds size limit")
    if not data.startswith(b"PK"):
        raise RuntimeError("ONLYOFFICE edited document is not a DOCX zip")
    return data


@router.get("", response_model=list[WordDocumentRead])
async def list_word_documents(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[WordDocumentRead]:
    await _require_book(db, current_user.id, book_id)
    documents = await word_crud.list_documents(
        db, book_id=book_id, user_id=current_user.id
    )
    return [WordDocumentRead.model_validate(document) for document in documents]


@router.post("", response_model=WordDocumentRead, status_code=201)
async def create_word_document(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: WordDocumentCreate,
) -> WordDocumentRead:
    await _require_book(db, current_user.id, book_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "O titulo nao pode estar vazio")

    body = blank_docx_bytes()
    object_key = (
        f"users/{current_user.id}/books/{book_id}/word-documents/{uuid4().hex}.docx"
    )
    await storage.upload(object_key, body, DOCX_CONTENT_TYPE)
    try:
        document = await word_crud.create_document(
            db,
            book_id=book_id,
            user_id=current_user.id,
            title=title,
            page=payload.page,
            object_key=object_key,
            file_size=len(body),
            content_type=DOCX_CONTENT_TYPE,
        )
    except SQLAlchemyError:
        await storage.delete(object_key)
        raise
    return WordDocumentRead.model_validate(document)


@router.get("/{document_id}", response_model=WordDocumentRead)
async def get_word_document(
    book_id: int, document_id: int, current_user: CurrentUser, db: DbSession
) -> WordDocumentRead:
    await _require_book(db, current_user.id, book_id)
    document = await _require_document(
        db, user_id=current_user.id, book_id=book_id, document_id=document_id
    )
    return WordDocumentRead.model_validate(document)


@router.patch("/{document_id}", response_model=WordDocumentRead)
async def update_word_document(
    book_id: int,
    document_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: WordDocumentUpdate,
) -> WordDocumentRead:
    await _require_book(db, current_user.id, book_id)
    document = await _require_document(
        db, user_id=current_user.id, book_id=book_id, document_id=document_id
    )

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "O titulo nao pode estar vazio")
        new_title = payload.title.strip()

    document = await word_crud.update_document(
        db,
        document,
        title=new_title,
        page=payload.page,
        set_page="page" in fields,
    )
    return WordDocumentRead.model_validate(document)


@router.delete("/{document_id}", status_code=204)
async def delete_word_document(
    book_id: int, document_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    document = await _require_document(
        db, user_id=current_user.id, book_id=book_id, document_id=document_id
    )
    object_key = document.object_key
    await word_crud.delete_document(db, document)
    await storage.delete(object_key)


@router.get("/{document_id}/download")
async def download_word_document(
    book_id: int, document_id: int, current_user: CurrentUser, db: DbSession
) -> StreamingResponse:
    await _require_book(db, current_user.id, book_id)
    document = await _require_document(
        db, user_id=current_user.id, book_id=book_id, document_id=document_id
    )
    return StreamingResponse(
        storage.stream(document.object_key),
        media_type=document.content_type,
        headers={
            "Content-Length": str(document.file_size),
            "Content-Disposition": f'attachment; filename="{_safe_filename(document.title)}"',
        },
    )


@router.post("/{document_id}/onlyoffice-config", response_model=OnlyOfficeEditorConfig)
async def get_onlyoffice_config(
    book_id: int,
    document_id: int,
    current_user: CurrentUser,
    db: DbSession,
    request: Request,
) -> OnlyOfficeEditorConfig:
    await _require_book(db, current_user.id, book_id)
    document = await _require_document(
        db, user_id=current_user.id, book_id=book_id, document_id=document_id
    )
    return _editor_config(request, document, current_user)


@onlyoffice_router.get("/{document_id}/content")
async def onlyoffice_document_content(
    document_id: int,
    db: DbSession,
    token: str = Query(min_length=20),
) -> StreamingResponse:
    document = await _document_from_signed_token(
        db, document_id=document_id, token=token
    )
    return StreamingResponse(
        storage.stream(document.object_key),
        media_type=document.content_type,
        headers={
            "Content-Length": str(document.file_size),
            "Content-Disposition": f'inline; filename="{_safe_filename(document.title)}"',
            "Cache-Control": "no-store",
        },
    )


@onlyoffice_router.post("/{document_id}/callback", response_model=None)
async def onlyoffice_document_callback(
    document_id: int,
    payload: OnlyOfficeCallback,
    db: DbSession,
    token: str = Query(min_length=20),
) -> Any:
    document = await _document_from_signed_token(
        db, document_id=document_id, token=token
    )

    if payload.status not in {2, 6}:
        return {"error": 0}
    if not payload.url:
        return JSONResponse({"error": 1}, status_code=400)
    if payload.key and not payload.key.startswith(f"word-{document.id}-"):
        return JSONResponse({"error": 1}, status_code=400)

    try:
        data = await _download_edited_docx(payload.url)
        await storage.upload(document.object_key, data, DOCX_CONTENT_TYPE)
        await word_crud.mark_document_saved(db, document, file_size=len(data))
    except Exception:
        return JSONResponse({"error": 1}, status_code=500)
    return {"error": 0}
