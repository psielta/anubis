from collections.abc import Sequence

from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.collection import Collection, book_collections


async def create(db: AsyncSession, *, user_id: int, name: str) -> Collection:
    collection = Collection(user_id=user_id, name=name)
    db.add(collection)
    await db.commit()
    await db.refresh(collection)
    return collection


async def list_for_user(
    db: AsyncSession, user_id: int
) -> Sequence[tuple[Collection, int]]:
    stmt = (
        select(Collection, func.count(book_collections.c.book_id))
        .outerjoin(
            book_collections, book_collections.c.collection_id == Collection.id
        )
        .where(Collection.user_id == user_id)
        .group_by(Collection.id)
        .order_by(Collection.name)
    )
    return [(c, count) for c, count in (await db.execute(stmt)).all()]


async def get_for_user(
    db: AsyncSession, user_id: int, collection_id: int
) -> Collection | None:
    return await db.scalar(
        select(Collection).where(
            Collection.id == collection_id, Collection.user_id == user_id
        )
    )


async def rename(db: AsyncSession, collection: Collection, name: str) -> Collection:
    collection.name = name
    await db.commit()
    await db.refresh(collection)
    return collection


async def delete_collection(db: AsyncSession, collection: Collection) -> None:
    await db.delete(collection)
    await db.commit()


async def set_book_collections(
    db: AsyncSession, *, user_id: int, book_id: int, collection_ids: list[int]
) -> None:
    """Replace a book's collections, keeping only ids owned by the user."""
    valid: set[int] = set()
    if collection_ids:
        valid = set(
            (
                await db.scalars(
                    select(Collection.id).where(
                        Collection.user_id == user_id,
                        Collection.id.in_(collection_ids),
                    )
                )
            ).all()
        )
    await db.execute(
        delete(book_collections).where(book_collections.c.book_id == book_id)
    )
    if valid:
        await db.execute(
            insert(book_collections),
            [{"book_id": book_id, "collection_id": cid} for cid in valid],
        )
    await db.commit()


async def collection_ids_for_book(db: AsyncSession, book_id: int) -> list[int]:
    return list(
        (
            await db.scalars(
                select(book_collections.c.collection_id).where(
                    book_collections.c.book_id == book_id
                )
            )
        ).all()
    )


async def collection_ids_for_books(
    db: AsyncSession, book_ids: list[int]
) -> dict[int, list[int]]:
    if not book_ids:
        return {}
    rows = await db.execute(
        select(book_collections.c.book_id, book_collections.c.collection_id).where(
            book_collections.c.book_id.in_(book_ids)
        )
    )
    result: dict[int, list[int]] = {}
    for book_id, collection_id in rows.all():
        result.setdefault(book_id, []).append(collection_id)
    return result
