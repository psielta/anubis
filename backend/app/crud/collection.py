from collections.abc import Sequence

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import Book
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
    requested_ids = list(dict.fromkeys(collection_ids))
    valid: set[int] = set()
    if collection_ids:
        valid = set(
            (
                await db.scalars(
                    select(Collection.id).where(
                        Collection.user_id == user_id,
                        Collection.id.in_(requested_ids),
                    )
                )
            ).all()
        )
    existing = set(
        (
            await db.scalars(
                select(book_collections.c.collection_id).where(
                    book_collections.c.book_id == book_id
                )
            )
        ).all()
    )

    delete_stmt = delete(book_collections).where(book_collections.c.book_id == book_id)
    await db.execute(
        delete_stmt.where(book_collections.c.collection_id.not_in(valid))
        if valid
        else delete_stmt
    )

    new_ids = [cid for cid in requested_ids if cid in valid and cid not in existing]
    rows: list[dict[str, int]] = []
    for cid in new_ids:
        next_position = (
            await db.scalar(
                select(func.coalesce(func.max(book_collections.c.position), -1) + 1)
                .select_from(book_collections)
                .where(book_collections.c.collection_id == cid)
            )
        ) or 0
        rows.append({"book_id": book_id, "collection_id": cid, "position": next_position})

    if rows:
        await db.execute(
            insert(book_collections),
            rows,
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


async def list_shelf_for_user(
    db: AsyncSession, user_id: int, *, limit_per_collection: int = 12
) -> Sequence[tuple[Collection, int, Sequence[Book]]]:
    rows = await list_for_user(db, user_id)
    result: list[tuple[Collection, int, Sequence[Book]]] = []
    for collection, count in rows:
        books = (
            await db.scalars(
                select(Book)
                .join(book_collections, book_collections.c.book_id == Book.id)
                .where(
                    Book.user_id == user_id,
                    book_collections.c.collection_id == collection.id,
                )
                .order_by(
                    book_collections.c.position.asc(),
                    Book.created_at.desc(),
                    Book.id.asc(),
                )
                .limit(limit_per_collection)
            )
        ).all()
        result.append((collection, count, books))
    return result


async def set_collection_order(
    db: AsyncSession, *, user_id: int, collection_id: int, book_ids: list[int]
) -> bool:
    collection = await get_for_user(db, user_id, collection_id)
    if collection is None:
        return False

    current_ids = list(
        (
            await db.scalars(
                select(book_collections.c.book_id)
                .join(Book, Book.id == book_collections.c.book_id)
                .where(
                    Book.user_id == user_id,
                    book_collections.c.collection_id == collection_id,
                )
                .order_by(
                    book_collections.c.position.asc(),
                    Book.created_at.desc(),
                    Book.id.asc(),
                )
            )
        ).all()
    )
    if set(book_ids) != set(current_ids) or len(book_ids) != len(current_ids):
        raise ValueError("Order must include each book in the collection exactly once")

    for position, book_id in enumerate(book_ids):
        await db.execute(
            update(book_collections)
            .where(
                book_collections.c.collection_id == collection_id,
                book_collections.c.book_id == book_id,
            )
            .values(position=position)
        )
    await db.commit()
    return True
