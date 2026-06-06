from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Single declarative base; all models inherit from it."""