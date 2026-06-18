from fastapi import APIRouter, HTTPException

from app.api.deps import CurrentUser, DbSession
from app.crud import book as book_crud
from app.crud import sketch as sketch_crud
from app.schemas.sketch import (
    SketchCreate,
    SketchGroupCreate,
    SketchGroupRead,
    SketchGroupUpdate,
    SketchRead,
    SketchUpdate,
)

groups_router = APIRouter(
    prefix="/books/{book_id}/sketch-groups", tags=["sketches"]
)
router = APIRouter(prefix="/books/{book_id}/sketches", tags=["sketches"])


async def _require_book(db: DbSession, user_id: int, book_id: int) -> None:
    if await book_crud.get_for_user(db, user_id, book_id) is None:
        raise HTTPException(404, "Book not found")


async def _require_group(
    db: DbSession, *, user_id: int, book_id: int, group_id: int | None
) -> None:
    if group_id is None:
        return
    group = await sketch_crud.get_group_for_user(
        db, group_id=group_id, book_id=book_id, user_id=user_id
    )
    if group is None:
        raise HTTPException(404, "Sketch group not found")


@groups_router.get("", response_model=list[SketchGroupRead])
async def list_sketch_groups(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[SketchGroupRead]:
    await _require_book(db, current_user.id, book_id)
    groups = await sketch_crud.list_groups(
        db, book_id=book_id, user_id=current_user.id
    )
    return [SketchGroupRead.model_validate(g) for g in groups]


@groups_router.post("", response_model=SketchGroupRead, status_code=201)
async def create_sketch_group(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: SketchGroupCreate,
) -> SketchGroupRead:
    await _require_book(db, current_user.id, book_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Name cannot be empty")
    group = await sketch_crud.create_group(
        db, book_id=book_id, user_id=current_user.id, name=name
    )
    return SketchGroupRead.model_validate(group)


@groups_router.patch("/{group_id}", response_model=SketchGroupRead)
async def update_sketch_group(
    book_id: int,
    group_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: SketchGroupUpdate,
) -> SketchGroupRead:
    await _require_book(db, current_user.id, book_id)
    group = await sketch_crud.get_group_for_user(
        db, group_id=group_id, book_id=book_id, user_id=current_user.id
    )
    if group is None:
        raise HTTPException(404, "Sketch group not found")

    fields = payload.model_fields_set
    new_name: str | None = None
    if "name" in fields:
        if payload.name is None or not payload.name.strip():
            raise HTTPException(422, "Name cannot be empty")
        new_name = payload.name.strip()

    group = await sketch_crud.update_group(
        db,
        group,
        name=new_name,
        position=payload.position if "position" in fields else None,
    )
    return SketchGroupRead.model_validate(group)


@groups_router.delete("/{group_id}", status_code=204)
async def delete_sketch_group(
    book_id: int, group_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    group = await sketch_crud.get_group_for_user(
        db, group_id=group_id, book_id=book_id, user_id=current_user.id
    )
    if group is None:
        raise HTTPException(404, "Sketch group not found")
    await sketch_crud.delete_group(db, group)


@router.get("", response_model=list[SketchRead])
async def list_sketches(
    book_id: int, current_user: CurrentUser, db: DbSession
) -> list[SketchRead]:
    await _require_book(db, current_user.id, book_id)
    sketches = await sketch_crud.list_sketches(
        db, book_id=book_id, user_id=current_user.id
    )
    return [SketchRead.model_validate(s) for s in sketches]


@router.post("", response_model=SketchRead, status_code=201)
async def create_sketch(
    book_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: SketchCreate,
) -> SketchRead:
    await _require_book(db, current_user.id, book_id)
    await _require_group(
        db, user_id=current_user.id, book_id=book_id, group_id=payload.group_id
    )
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "Title cannot be empty")
    sketch = await sketch_crud.create_sketch(
        db,
        book_id=book_id,
        user_id=current_user.id,
        title=title,
        content=payload.content,
        group_id=payload.group_id,
        page=payload.page,
    )
    return SketchRead.model_validate(sketch)


@router.get("/{sketch_id}", response_model=SketchRead)
async def get_sketch(
    book_id: int, sketch_id: int, current_user: CurrentUser, db: DbSession
) -> SketchRead:
    await _require_book(db, current_user.id, book_id)
    sketch = await sketch_crud.get_sketch_for_user(
        db, sketch_id=sketch_id, book_id=book_id, user_id=current_user.id
    )
    if sketch is None:
        raise HTTPException(404, "Sketch not found")
    return SketchRead.model_validate(sketch)


@router.patch("/{sketch_id}", response_model=SketchRead)
async def update_sketch(
    book_id: int,
    sketch_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: SketchUpdate,
) -> SketchRead:
    await _require_book(db, current_user.id, book_id)
    sketch = await sketch_crud.get_sketch_for_user(
        db, sketch_id=sketch_id, book_id=book_id, user_id=current_user.id
    )
    if sketch is None:
        raise HTTPException(404, "Sketch not found")

    fields = payload.model_fields_set
    new_title: str | None = None
    if "title" in fields:
        if payload.title is None or not payload.title.strip():
            raise HTTPException(422, "Title cannot be empty")
        new_title = payload.title.strip()

    if "group_id" in fields:
        await _require_group(
            db, user_id=current_user.id, book_id=book_id, group_id=payload.group_id
        )

    sketch = await sketch_crud.update_sketch(
        db,
        sketch,
        title=new_title,
        content=payload.content if "content" in fields else None,
        group_id=payload.group_id,
        set_group="group_id" in fields,
        page=payload.page,
        set_page="page" in fields,
    )
    return SketchRead.model_validate(sketch)


@router.delete("/{sketch_id}", status_code=204)
async def delete_sketch(
    book_id: int, sketch_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    await _require_book(db, current_user.id, book_id)
    sketch = await sketch_crud.get_sketch_for_user(
        db, sketch_id=sketch_id, book_id=book_id, user_id=current_user.id
    )
    if sketch is None:
        raise HTTPException(404, "Sketch not found")
    await sketch_crud.delete_sketch(db, sketch)
