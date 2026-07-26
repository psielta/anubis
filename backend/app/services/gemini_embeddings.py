"""Gemini embeddings client for RAG (batch-friendly with per-item fallback)."""

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


def _normalize_embedding(
    values: Sequence[float], dim: int = RAG_EMBEDDING_DIM
) -> list[float]:
    vec = [float(v) for v in values]
    if len(vec) == dim:
        return vec
    if len(vec) > dim:
        return vec[:dim]
    return vec + [0.0] * (dim - len(vec))


def _extract_embeddings(result: object) -> list[object]:
    embeddings = getattr(result, "embeddings", None) or []
    if embeddings:
        return list(embeddings)
    # Some responses expose a singular embedding field.
    single = getattr(result, "embedding", None)
    if single is not None:
        return [single]
    return []


def _values_from_embedding(emb: object) -> list[float] | None:
    values = getattr(emb, "values", None)
    if values is None and isinstance(emb, Sequence) and not isinstance(emb, (str, bytes)):
        values = emb
    if not values:
        return None
    return list(values)


async def _embed_one(
    gemini: genai.Client,
    text: str,
    *,
    task_type: str,
) -> list[float]:
    content = text if text.strip() else " "
    try:
        result = await gemini.aio.models.embed_content(
            model=settings.GEMINI_EMBEDDING_MODEL,
            contents=content,
            config=types.EmbedContentConfig(
                task_type=task_type,
                output_dimensionality=RAG_EMBEDDING_DIM,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingError(str(exc)[:500]) from exc

    embeddings = _extract_embeddings(result)
    if not embeddings:
        if not text.strip():
            return [0.0] * RAG_EMBEDDING_DIM
        raise EmbeddingError("empty embedding returned")
    values = _values_from_embedding(embeddings[0])
    if not values:
        if not text.strip():
            return [0.0] * RAG_EMBEDDING_DIM
        raise EmbeddingError("empty embedding returned")
    return _normalize_embedding(values)


async def _embed_batch_once(
    gemini: genai.Client,
    texts: list[str],
    *,
    task_type: str,
) -> list[list[float]] | None:
    """
    Try multi-content embed in one request.

    Returns a list of vectors on full success, or None when the API only
    returned a partial batch (e.g. gemini-embedding-2 returns 1 for N texts).
    """
    contents = [t if t.strip() else " " for t in texts]
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
        logger.exception("Gemini embed_content batch failed")
        raise EmbeddingError(str(exc)[:500]) from exc

    embeddings = _extract_embeddings(result)
    if len(embeddings) != len(texts):
        logger.warning(
            "embed_content returned %s embeddings for %s texts (model=%s); "
            "falling back to per-item embedding",
            len(embeddings),
            len(texts),
            settings.GEMINI_EMBEDDING_MODEL,
        )
        return None

    out: list[list[float]] = []
    for i, emb in enumerate(embeddings):
        values = _values_from_embedding(emb)
        if not values:
            if not texts[i].strip():
                out.append([0.0] * RAG_EMBEDDING_DIM)
                continue
            raise EmbeddingError("empty embedding returned")
        out.append(_normalize_embedding(values))
    return out


async def embed_texts(
    texts: list[str],
    *,
    gemini: genai.Client | None = None,
    task_type: str = "RETRIEVAL_DOCUMENT",
) -> list[list[float]]:
    """
    Embed a list of texts with Gemini.

    Tries multi-content batches (RAG_EMBED_BATCH_SIZE). If the model returns
    fewer vectors than inputs (observed with gemini-embedding-2), falls back
    to embedding each text individually (with bounded concurrency).
    """
    if not texts:
        return []
    if not configured():
        raise EmbeddingError("GEMINI_API_KEY is not configured")

    gemini = gemini or client()
    batch_size = max(1, settings.RAG_EMBED_BATCH_SIZE)
    out: list[list[float]] = []
    # Cap concurrent single embeds to avoid hammering the API on large books.
    single_concurrency = max(1, min(8, settings.RAG_EMBED_BATCH_SIZE))

    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        if len(batch) == 1:
            out.append(await _embed_one(gemini, batch[0], task_type=task_type))
            continue

        vectors = await _embed_batch_once(gemini, batch, task_type=task_type)
        if vectors is not None:
            out.extend(vectors)
            continue

        # Per-item fallback with limited concurrency.
        sem = asyncio.Semaphore(single_concurrency)

        async def _one(t: str) -> list[float]:
            async with sem:
                return await _embed_one(gemini, t, task_type=task_type)

        part = await asyncio.gather(*[_one(t) for t in batch])
        out.extend(part)

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
