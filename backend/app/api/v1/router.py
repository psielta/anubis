from fastapi import APIRouter

from app.api.v1.endpoints import (
    auth,
    books,
    collections,
    diagrams,
    latex_notebooks,
    notes,
    sketches,
    study,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(books.router)
api_router.include_router(collections.router)
api_router.include_router(diagrams.router)
api_router.include_router(latex_notebooks.groups_router)
api_router.include_router(latex_notebooks.router)
api_router.include_router(notes.router)
api_router.include_router(sketches.groups_router)
api_router.include_router(sketches.router)
api_router.include_router(study.router)
api_router.include_router(users.router)
