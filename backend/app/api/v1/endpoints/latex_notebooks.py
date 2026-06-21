from fastapi import APIRouter, HTTPException

from app.api.deps import CurrentUser, DbSession
from app.crud import book as book_crud
from app.crud import latex_notebook as latex_crud
from app.schemas.latex_notebook import (
    LatexNotebookCreate,
    LatexNotebookGroupCreate,
    LatexNotebookGroupRead,
    LatexNotebookGroupUpdate,
    LatexNotebookRead,
    LatexNotebookUpdate,
)

groups_router = APIRouter(
    prefix="/books/{book_id}/latex-notebook-groups", tags=["latex-notebooks"]
)
router = APIRouter(prefix="/books/{book_id}/latex-notebooks", tags=["latex-notebooks"])


async def _require_book(db: DbSession, user_id: int, book_id: int) -> None:
    if await book_crud.get_for_user(db, user_id, book_id) is None:
        raise HTTPException(404, "Livro não encontrado")


async def _require_group(
    db: DbSession, *, user_id: int, book_id: int, group_id: int | None
) -> None:
    if group_id is None:
        return
    group = await latex_crud.get_group_for_user(
        db, group_id=group_id, book_id=book_id, user_id=user_id
    )
    if group is None:
        raise HTTPException(404, "Grupo de cadernos LaTeX não encontrado")


@groups_router.get("", response_model=list[LatexNotebookGroupRead])
async def list_latex_notebook_groups(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[LatexNotebookGroupRead]:
    await _require_book(db, current_user.id, book_id)
    groups = await latex_crud.list_groups(
        db, book_id=book_id, user_id=current_user.id
    )
    return [LatexNotebookGroupRead.model_validate(g) for g in groups]


@groups_router.post("", response_model=LatexNotebookGroupRead, status_code=201)
async def create_latex_notebook_group(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: LatexNotebookGroupCreate,
) -> LatexNotebookGroupRead:
    await _require_book(db, current_user.id, book_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "O nome não pode estar vazio")
    group = await latex_crud.create_group(
        db, book_id=book_id, user_id=current_user.id, name=name
    )
    return LatexNotebookGroupRead.model_validate(group)


@groups_router.patch("/{group_id}", response_model=LatexNotebookGroupRead)
async def update_latex_notebook_group(
    book_id: int,
    group_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: LatexNotebookGroupUpdate,
) -> LatexNotebookGroupRead:
    await _require_book(db, current_user.id, book_id)
    group = await latex_crud.get_group_for_user(
        db, group_id=group_id, book_id=book_id, user_id=current_user.id
    )
    if group is None:
        raise HTTPException(404, "Grupo de cadernos LaTeX não encontrado")

    fields = payload.model_fields_set
    new_name: str | None = None
    if "name" in fields:
        if payload.name is None or not payload.name.strip():
            raise HTTPException(422, "O nome não pode estar vazio")
        new_name = payload.name.strip()

    group = await latex_crud.update_group(
        db,
        group,
        name=new_name,
        position=payload.position if "position" in fields else None,
    )
    return LatexNotebookGroupRead.model_validate(group)


@groups_router.delete("/{group_id}", status_code=204)
async def delete_latex_notebook_group(
    book_id: int, group_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    group = await latex_crud.get_group_for_user(
        db, group_id=group_id, book_id=book_id, user_id=current_user.id
    )
    if group is None:
        raise HTTPException(404, "Grupo de cadernos LaTeX não encontrado")
    await latex_crud.delete_group(db, group)


@router.get("", response_model=list[LatexNotebookRead])
async def list_latex_notebooks(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[LatexNotebookRead]:
    await _require_book(db, current_user.id, book_id)
    notebooks = await latex_crud.list_notebooks(
        db, book_id=book_id, user_id=current_user.id
    )
    return [LatexNotebookRead.model_validate(n) for n in notebooks]


@router.post("", response_model=LatexNotebookRead, status_code=201)
async def create_latex_notebook(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: LatexNotebookCreate,
) -> LatexNotebookRead:
    await _require_book(db, current_user.id, book_id)
    await _require_group(
        db, user_id=current_user.id, book_id=book_id, group_id=payload.group_id
    )
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "O título não pode estar vazio")
    notebook = await latex_crud.create_notebook(
        db,
        book_id=book_id,
        user_id=current_user.id,
        title=title,
        content=payload.content,
        group_id=payload.group_id,
        page=payload.page,
    )
    return LatexNotebookRead.model_validate(notebook)


@router.get("/{notebook_id}", response_model=LatexNotebookRead)
async def get_latex_notebook(
    book_id: int, notebook_id: int, current_user: CurrentUser, db: DbSession
) -> LatexNotebookRead:
    await _require_book(db, current_user.id, book_id)
    notebook = await latex_crud.get_notebook_for_user(
        db, notebook_id=notebook_id, book_id=book_id, user_id=current_user.id
    )
    if notebook is None:
        raise HTTPException(404, "Caderno LaTeX não encontrado")
    return LatexNotebookRead.model_validate(notebook)


@router.patch("/{notebook_id}", response_model=LatexNotebookRead)
async def update_latex_notebook(
    book_id: int,
    notebook_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: LatexNotebookUpdate,
) -> LatexNotebookRead:
    await _require_book(db, current_user.id, book_id)
    notebook = await latex_crud.get_notebook_for_user(
        db, notebook_id=notebook_id, book_id=book_id, user_id=current_user.id
    )
    if notebook is None:
        raise HTTPException(404, "Caderno LaTeX não encontrado")

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "O título não pode estar vazio")
        new_title = payload.title.strip()

    if "group_id" in fields:
        await _require_group(
            db, user_id=current_user.id, book_id=book_id, group_id=payload.group_id
        )

    notebook = await latex_crud.update_notebook(
        db,
        notebook,
        title=new_title,
        content=payload.content if "content" in fields else None,
        group_id=payload.group_id,
        set_group="group_id" in fields,
        page=payload.page,
        set_page="page" in fields,
    )
    return LatexNotebookRead.model_validate(notebook)


@router.delete("/{notebook_id}", status_code=204)
async def delete_latex_notebook(
    book_id: int, notebook_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    notebook = await latex_crud.get_notebook_for_user(
        db, notebook_id=notebook_id, book_id=book_id, user_id=current_user.id
    )
    if notebook is None:
        raise HTTPException(404, "Caderno LaTeX não encontrado")
    await latex_crud.delete_notebook(db, notebook)
