from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")

    PROJECT_NAME: str = "Anubis"
    API_V1_STR: str = "/api/v1"
    ENVIRONMENT: str = "development"

    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    DATABASE_URL: str
    BACKEND_CORS_ORIGINS: list[str] = ["http://localhost:4200"]

    S3_ENDPOINT_URL: str = "http://localhost:9000"
    S3_ACCESS_KEY: str
    S3_SECRET_KEY: str
    S3_BUCKET: str = "anubis-library"
    S3_REGION: str = "us-east-1"
    # Upload limits — overridable via .env. Note: the dev server reloads on
    # .py changes only, so editing .env requires restarting the backend.
    MAX_UPLOAD_SIZE_MB: int = 250
    MAX_COVER_SIZE_MB: int = 5

    # AI study assistant (Gemini). Override GEMINI_MODEL via .env as the
    # lineup evolves (e.g. gemini-2.5-flash, gemini-3-flash-preview).
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-2.5-flash"
    AI_INLINE_MAX_MB: int = 15

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def _split_cors(cls, v: object) -> object:
        if isinstance(v, str) and not v.startswith("["):
            return [o.strip() for o in v.split(",")]
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()