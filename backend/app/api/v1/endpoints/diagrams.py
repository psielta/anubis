from fastapi import APIRouter, HTTPException

from app.api.deps import CurrentUser, DbSession
from app.crud import book as book_crud
from app.crud import diagram as diagram_crud
from app.schemas.diagram import DiagramCreate, DiagramRead, DiagramUpdate

router = APIRouter(prefix="/books/{book_id}/diagrams", tags=["diagrams"])


async def _require_book(db: DbSession, user_id: int, book_id: int) -> None:
    if await book_crud.get_for_user(db, user_id, book_id) is None:
        raise HTTPException(404, "Livro não encontrado")


@router.get("", response_model=list[DiagramRead])
async def list_diagrams(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[DiagramRead]:
    await _require_book(db, current_user.id, book_id)
    diagrams = await diagram_crud.list_for_book(
        db, book_id=book_id, user_id=current_user.id
    )
    return [DiagramRead.model_validate(d) for d in diagrams]


@router.post("", response_model=DiagramRead, status_code=201)
async def create_diagram(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: DiagramCreate,
) -> DiagramRead:
    await _require_book(db, current_user.id, book_id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "O título não pode estar vazio")
    diagram = await diagram_crud.create(
        db,
        book_id=book_id,
        user_id=current_user.id,
        title=title,
        type=payload.type,
        content=payload.content,
        page=payload.page,
    )
    return DiagramRead.model_validate(diagram)


@router.get("/{diagram_id}", response_model=DiagramRead)
async def get_diagram(
    book_id: int, diagram_id: int, current_user: CurrentUser, db: DbSession
) -> DiagramRead:
    await _require_book(db, current_user.id, book_id)
    diagram = await diagram_crud.get_for_user(
        db, diagram_id=diagram_id, book_id=book_id, user_id=current_user.id
    )
    if diagram is None:
        raise HTTPException(404, "Diagrama não encontrado")
    return DiagramRead.model_validate(diagram)


@router.patch("/{diagram_id}", response_model=DiagramRead)
async def update_diagram(
    book_id: int,
    diagram_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: DiagramUpdate,
) -> DiagramRead:
    await _require_book(db, current_user.id, book_id)
    diagram = await diagram_crud.get_for_user(
        db, diagram_id=diagram_id, book_id=book_id, user_id=current_user.id
    )
    if diagram is None:
        raise HTTPException(404, "Diagrama não encontrado")

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:  # title present: must not be null/empty
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "O título não pode estar vazio")
        new_title = payload.title.strip()

    diagram = await diagram_crud.update(
        db,
        diagram,
        title=new_title,
        content=payload.content if "content" in fields else None,
        page=payload.page,
        set_page="page" in fields,
    )
    return DiagramRead.model_validate(diagram)


@router.delete("/{diagram_id}", status_code=204)
async def delete_diagram(
    book_id: int, diagram_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    diagram = await diagram_crud.get_for_user(
        db, diagram_id=diagram_id, book_id=book_id, user_id=current_user.id
    )
    if diagram is None:
        raise HTTPException(404, "Diagrama não encontrado")
    await diagram_crud.delete(db, diagram)
