from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.crud import collection as collection_crud
from app.models.collection import Collection
from app.schemas.book import BookRead
from app.schemas.collection import (
    CollectionCreate,
    CollectionOrderUpdate,
    CollectionRead,
    CollectionShelfRead,
    CollectionUpdate,
)

router = APIRouter(prefix="/collections", tags=["collections"])


def _read(collection: Collection, book_count: int = 0) -> CollectionRead:
    return CollectionRead(id=collection.id, name=collection.name, book_count=book_count)


@router.get("", response_model=list[CollectionRead])
async def list_collections(
    current_user: CurrentUser, db: DbSession
) -> list[CollectionRead]:
    rows = await collection_crud.list_for_user(db, current_user.id)
    return [_read(collection, count) for collection, count in rows]


@router.post("", response_model=CollectionRead, status_code=201)
async def create_collection(
    current_user: CurrentUser, db: DbSession, payload: CollectionCreate
) -> CollectionRead:
    try:
        collection = await collection_crud.create(
            db, user_id=current_user.id, name=payload.name.strip()
        )
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "A collection with that name already exists")
    return _read(collection)


@router.get("/shelf", response_model=list[CollectionShelfRead])
async def list_collection_shelf(
    current_user: CurrentUser,
    db: DbSession,
    limit_per_collection: Annotated[int, Query(ge=1, le=24)] = 12,
) -> list[CollectionShelfRead]:
    rows = await collection_crud.list_shelf_for_user(
        db, current_user.id, limit_per_collection=limit_per_collection
    )
    book_ids = [book.id for _, _, books in rows for book in books]
    coll_map = await collection_crud.collection_ids_for_books(db, book_ids)
    result: list[CollectionShelfRead] = []
    for collection, count, books in rows:
        items = [
            BookRead.model_validate(book).model_copy(
                update={"collection_ids": coll_map.get(book.id, [])}
            )
            for book in books
        ]
        result.append(
            CollectionShelfRead(
                id=collection.id,
                name=collection.name,
                book_count=count,
                items=items,
            )
        )
    return result


@router.put("/{collection_id}/books/order", response_model=CollectionRead)
async def reorder_collection_books(
    collection_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: CollectionOrderUpdate,
) -> CollectionRead:
    try:
        changed = await collection_crud.set_collection_order(
            db,
            user_id=current_user.id,
            collection_id=collection_id,
            book_ids=payload.book_ids,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if not changed:
        raise HTTPException(404, "Collection not found")
    collection = await collection_crud.get_for_user(db, current_user.id, collection_id)
    if collection is None:
        raise HTTPException(404, "Collection not found")
    return _read(collection, len(payload.book_ids))


@router.patch("/{collection_id}", response_model=CollectionRead)
async def rename_collection(
    collection_id: int,
    current_user: CurrentUser,
    db: DbSession,
    payload: CollectionUpdate,
) -> CollectionRead:
    collection = await collection_crud.get_for_user(db, current_user.id, collection_id)
    if collection is None:
        raise HTTPException(404, "Collection not found")
    try:
        collection = await collection_crud.rename(db, collection, payload.name.strip())
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "A collection with that name already exists")
    return _read(collection)


@router.delete("/{collection_id}", status_code=204)
async def delete_collection(
    collection_id: int, current_user: CurrentUser, db: DbSession
) -> None:
    collection = await collection_crud.get_for_user(db, current_user.id, collection_id)
    if collection is None:
        raise HTTPException(404, "Collection not found")
    await collection_crud.delete_collection(db, collection)
