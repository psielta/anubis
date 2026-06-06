from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import (
    hash_password,
    hash_refresh_jti,
    verify_password,
)
from app.models.user import User
from app.schemas.user import UserCreate


async def get_by_email(db: AsyncSession, email: str) -> User | None:
    return await db.scalar(select(User).where(User.email == email))


async def get_by_id(db: AsyncSession, user_id: int) -> User | None:
    return await db.get(User, user_id)


async def create(db: AsyncSession, data: UserCreate) -> User:
    user = User(
        email=data.email,
        full_name=data.full_name,
        hashed_password=hash_password(data.password),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise
    await db.refresh(user)
    return user


async def authenticate(db: AsyncSession, email: str, password: str) -> User | None:
    user = await get_by_email(db, email)
    if not user or not verify_password(password, user.hashed_password):
        return None
    return user


async def set_refresh_jti(db: AsyncSession, user: User, jti: str) -> None:
    user.refresh_token_jti_hash = hash_refresh_jti(jti)
    await db.commit()


async def clear_refresh_jti(db: AsyncSession, user: User) -> None:
    user.refresh_token_jti_hash = None
    await db.commit()


async def validate_refresh_jti(user: User, jti: str | None) -> bool:
    from app.core.security import verify_refresh_jti

    return verify_refresh_jti(jti or "", user.refresh_token_jti_hash)