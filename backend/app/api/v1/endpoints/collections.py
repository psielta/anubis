from fastapi import APIRouter, HTTPException
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.crud import collection as collection_crud
from app.models.collection import Collection
from app.schemas.collection import CollectionCreate, CollectionRead, CollectionUpdate

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
