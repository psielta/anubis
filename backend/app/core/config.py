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

    # AI study assistant + page translation (Gemini). Override GEMINI_MODEL via
    # .env as the lineup evolves (e.g. gemini-3.5-flash, gemini-3-flash-preview).
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.5-flash"
    AI_INLINE_MAX_MB: int = 15

    REDIS_URL: str = "redis://localhost:6379/0"

    # ONLYOFFICE Document Server (Word documents linked to books)
    ONLYOFFICE_ENABLED: bool = True
    ONLYOFFICE_DOCSERVER_PUBLIC_URL: str = "http://localhost:8082"
    ONLYOFFICE_DOCSERVER_INTERNAL_URL: str = ""
    ONLYOFFICE_JWT_SECRET: str = ""
    ONLYOFFICE_JWT_HEADER: str = "Authorization"
    ONLYOFFICE_CALLBACK_BASE_URL: str = ""
    ONLYOFFICE_CALLBACK_TOKEN_HOURS: int = 24
    ONLYOFFICE_MAX_DOCX_MB: int = 50

    # PDF → Markdown conversion limits
    PDF_CONVERSION_MAX_UPLOAD_MB: int = 100
    PDF_CONVERSION_MAX_PAGES: int = 500
    PDF_CONVERSION_TIMEOUT_SECONDS: int = 600
    PDF_CONVERSION_CHUNK_MAX_CHARS: int = 10000
    PDF_CONVERSION_OUTBOX_MAX_ATTEMPTS: int = 3
    PDF_CONVERSION_OUTBOX_LEASE_SECONDS: int = 300
    PDF_CONVERSION_OUTBOX_POLL_SECONDS: float = 2.0

    # Book RAG (Gemini embeddings + LLM over pgvector)
    # GEMINI_API_KEY is shared with the study assistant (never hardcode secrets).
    # text-embedding-004 was retired from v1beta embedContent; use gemini-embedding-*.
    GEMINI_EMBEDDING_MODEL: str = "gemini-embedding-001"
    RAG_CHUNK_MAX_CHARS: int = 2000
    RAG_CHUNK_OVERLAP_CHARS: int = 200
    RAG_EMBED_BATCH_SIZE: int = 32
    RAG_TOP_K_DEFAULT: int = 5
    RAG_OUTBOX_MAX_ATTEMPTS: int = 5
    RAG_OUTBOX_LEASE_SECONDS: int = 600

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
