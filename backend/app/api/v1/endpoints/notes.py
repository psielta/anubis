from fastapi import APIRouter, HTTPException

from app.api.deps import CurrentUser, DbSession
from app.crud import book as book_crud
from app.crud import note as note_crud
from app.schemas.note import NoteCreate, NoteRead, NoteUpdate

router = APIRouter(prefix="/books/{book_id}/notes", tags=["notes"])


async def _require_book(db: DbSession, user_id: int, book_id: int) -> None:
    if await book_crud.get_for_user(db, user_id, book_id) is None:
        raise HTTPException(404, "Book not found")


@router.get("", response_model=list[NoteRead])
async def list_notes(
    book_id: int, current_user: CurrentUser, db: DbSession, q: str | None = None
) -> list[NoteRead]:
    await _require_book(db, current_user.id, book_id)
    search = q.strip() if q else None
    notes = await note_crud.list_for_book(
        db, book_id=book_id, user_id=current_user.id, query=search or None
    )
    return [NoteRead.model_validate(n) for n in notes]


@router.post("", response_model=NoteRead, status_code=201)
async def create_note(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: NoteCreate,
) -> NoteRead:
    await _require_book(db, current_user.id, book_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "Title cannot be empty")
    note = await note_crud.create(
        db,
        book_id=book_id,
        user_id=current_user.id,
        title=title,
        content=payload.content,
        page=payload.page,
    )
    return NoteRead.model_validate(note)


@router.get("/{note_id}", response_model=NoteRead)
async def get_note(
    book_id: int, note_id: int, current_user: CurrentUser, db: DbSession
) -> NoteRead:
    await _require_book(db, current_user.id, book_id)
    note = await note_crud.get_for_user(
        db, note_id=note_id, book_id=book_id, user_id=current_user.id
    )
    if note is None:
        raise HTTPException(404, "Note not found")
    return NoteRead.model_validate(note)


@router.patch("/{note_id}", response_model=NoteRead)
async def update_note(
    book_id: int,
    note_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: NoteUpdate,
) -> NoteRead:
    await _require_book(db, current_user.id, book_id)
    note = await note_crud.get_for_user(
        db, note_id=note_id, book_id=book_id, user_id=current_user.id
    )
    if note is None:
        raise HTTPException(404, "Note not found")

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:  # title present: must not be null/empty
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "Title cannot be empty")
        new_title = payload.title.strip()

    note = await note_crud.update(
        db,
        note,
        title=new_title,
        content=payload.content if "content" in fields else None,
        page=payload.page,
        set_page="page" in fields,
    )
    return NoteRead.model_validate(note)


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    book_id: int, note_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    note = await note_crud.get_for_user(
        db, note_id=note_id, book_id=book_id, user_id=current_user.id
    )
    if note is None:
        raise HTTPException(404, "Note not found")
    await note_crud.delete(db, note)
