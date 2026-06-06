import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def _create_token(subject: str | int, expires: timedelta, token_type: str) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "iat": now,
        "exp": now + expires,
        "type": token_type,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_access_token(subject: str | int) -> str:
    return _create_token(
        subject, timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES), "access"
    )


def new_refresh_jti() -> str:
    return secrets.token_urlsafe(32)


def hash_refresh_jti(jti: str) -> str:
    return hashlib.sha256(jti.encode()).hexdigest()


def verify_refresh_jti(jti: str, stored_hash: str | None) -> bool:
    if not jti or not stored_hash:
        return False
    return secrets.compare_digest(hash_refresh_jti(jti), stored_hash)


def create_refresh_token(subject: str | int, jti: str) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "iat": now,
        "exp": now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        "type": "refresh",
        "jti": jti,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])