"""Gemini embeddings client for RAG (batch-friendly)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence

from google import genai
from google.genai import types

from app.core.config import settings
from app.models.rag import RAG_EMBEDDING_DIM

logger = logging.getLogger(__name__)


class EmbeddingError(Exception):
    """Raised when Gemini embedding fails."""


def configured() -> bool:
    return bool(settings.GEMINI_API_KEY)


def client() -> genai.Client:
    return genai.Client(api_key=settings.GEMINI_API_KEY)


def _normalize_embedding(values: Sequence[float], dim: int = RAG_EMBEDDING_DIM) -> list[float]:
    vec = [float(v) for v in values]
    if len(vec) == dim:
        return vec
    if len(vec) > dim:
        return vec[:dim]
    # Pad (should not happen with configured model); keep length fixed for pgvector.
    return vec + [0.0] * (dim - len(vec))


async def embed_texts(
    texts: list[str],
    *,
    gemini: genai.Client | None = None,
    task_type: str = "RETRIEVAL_DOCUMENT",
) -> list[list[float]]:
    """
    Embed a list of texts with Gemini.

    Batches by RAG_EMBED_BATCH_SIZE. Empty strings become zero vectors.
    """
    if not texts:
        return []
    if not configured():
        raise EmbeddingError("GEMINI_API_KEY is not configured")

    gemini = gemini or client()
    batch_size = max(1, settings.RAG_EMBED_BATCH_SIZE)
    out: list[list[float]] = []

    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        # Replace empty with a space so the API accepts the item; zero after if needed.
        contents = [t if t.strip() else " " for t in batch]
        try:
            result = await gemini.aio.models.embed_content(
                model=settings.GEMINI_EMBEDDING_MODEL,
                contents=contents,  # type: ignore[arg-type]
                config=types.EmbedContentConfig(
                    task_type=task_type,
                    output_dimensionality=RAG_EMBEDDING_DIM,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Gemini embed_content failed for batch@%s", start)
            raise EmbeddingError(str(exc)[:500]) from exc

        embeddings = getattr(result, "embeddings", None) or []
        if len(embeddings) != len(batch):
            # Some SDK versions return a single embedding object for one input.
            if len(batch) == 1 and embeddings:
                embeddings = [embeddings[0]]
            else:
                raise EmbeddingError(
                    f"expected {len(batch)} embeddings, got {len(embeddings)}"
                )

        for i, emb in enumerate(embeddings):
            values = getattr(emb, "values", None)
            if values is None and isinstance(emb, Sequence):
                values = emb
            if not values:
                if not batch[i].strip():
                    out.append([0.0] * RAG_EMBEDDING_DIM)
                    continue
                raise EmbeddingError("empty embedding returned")
            out.append(_normalize_embedding(values))

    return out


async def embed_query(
    question: str,
    *,
    gemini: genai.Client | None = None,
) -> list[float]:
    vectors = await embed_texts(
        [question],
        gemini=gemini,
        task_type="RETRIEVAL_QUERY",
    )
    return vectors[0]


async def embed_texts_with_retry(
    texts: list[str],
    *,
    gemini: genai.Client | None = None,
    task_type: str = "RETRIEVAL_DOCUMENT",
    attempts: int = 3,
) -> list[list[float]]:
    last: Exception | None = None
    for i in range(attempts):
        try:
            return await embed_texts(texts, gemini=gemini, task_type=task_type)
        except EmbeddingError as exc:
            last = exc
            await asyncio.sleep(min(30, 2**i))
    assert last is not None
    raise last
