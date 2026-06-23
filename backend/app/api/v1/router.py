from fastapi import APIRouter

from app.api.v1.endpoints import (
    auth,
    books,
    collections,
    diagrams,
    exercise_resolutions,
    latex_notebooks,
    notes,
    pdf_conversions,
    sketches,
    study,
    translate,
    users,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(books.router)
api_router.include_router(collections.router)
api_router.include_router(diagrams.router)
api_router.include_router(exercise_resolutions.router)
api_router.include_router(latex_notebooks.groups_router)
api_router.include_router(latex_notebooks.router)
api_router.include_router(notes.router)
api_router.include_router(pdf_conversions.router)
api_router.include_router(sketches.groups_router)
api_router.include_router(sketches.router)
api_router.include_router(study.router)
api_router.include_router(translate.router)
api_router.include_router(users.router)
