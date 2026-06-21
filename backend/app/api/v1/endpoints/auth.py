import jwt
from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import DbSession
from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    new_refresh_jti,
)
from app.crud import user as user_crud
from app.models.user import User
from app.schemas.token import AccessToken, LoginRequest
from app.schemas.user import UserCreate, UserRead

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "anubis_refresh"
REFRESH_PATH = f"{settings.API_V1_STR}/auth"


async def _issue_refresh_cookie(
    response: Response, db: AsyncSession, user: User
) -> None:
    jti = new_refresh_jti()
    await user_crud.set_refresh_jti(db, user, jti)
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=create_refresh_token(user.id, jti),
        httponly=True,
        secure=settings.ENVIRONMENT != "development",
        samesite="lax",
        path=REFRESH_PATH,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600,
    )


@router.post("/register", response_model=UserRead, status_code=201)
async def register(data: UserCreate, db: DbSession) -> UserRead:
    if await user_crud.get_by_email(db, data.email):
        raise HTTPException(409, "E-mail já cadastrado")
    try:
        return await user_crud.create(db, data)  # type: ignore[return-value]
    except IntegrityError:
        raise HTTPException(409, "E-mail já cadastrado")


@router.post("/login", response_model=AccessToken)
async def login(data: LoginRequest, response: Response, db: DbSession) -> AccessToken:
    user = await user_crud.authenticate(db, data.email, data.password)
    if not user:
        raise HTTPException(401, "E-mail ou senha incorretos")
    if not user.is_active:
        raise HTTPException(400, "Usuário inativo")
    await _issue_refresh_cookie(response, db, user)
    return AccessToken(access_token=create_access_token(user.id))


@router.post("/refresh", response_model=AccessToken)
async def refresh(request: Request, response: Response, db: DbSession) -> AccessToken:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(401, "Token de atualização ausente")
    try:
        payload = decode_token(token)
        if payload.get("type") != "refresh" or payload.get("jti") is None:
            raise HTTPException(401, "Token de atualização inválido")
    except jwt.PyJWTError:
        raise HTTPException(401, "Token de atualização inválido")

    user = await user_crud.get_by_id(db, int(payload["sub"]))
    if not user or not user.is_active:
        raise HTTPException(401, "Token de atualização inválido")
    if not await user_crud.validate_refresh_jti(user, payload.get("jti")):
        raise HTTPException(401, "Token de atualização inválido")

    await _issue_refresh_cookie(response, db, user)
    return AccessToken(access_token=create_access_token(user.id))


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: DbSession) -> None:
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        try:
            payload = decode_token(token)
            user = await user_crud.get_by_id(db, int(payload["sub"]))
            if user:
                await user_crud.clear_refresh_jti(db, user)
        except jwt.PyJWTError:
            pass
    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_PATH)