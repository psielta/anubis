from fastapi import APIRouter

from app.api.v1.endpoints import auth, books, collections, study, users

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(books.router)
api_router.include_router(collections.router)
api_router.include_router(study.router)
api_router.include_router(users.router)