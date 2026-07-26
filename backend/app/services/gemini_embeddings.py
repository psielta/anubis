"""Gemini embeddings for RAG — reliable batches + backoff on 503."""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Sequence

from google import genai
from google.genai import types

from app.core.config import settings
from app.models.rag import RAG_EMBEDDING_DIM

logger = logging.getLogger(__name__)


class EmbeddingError(Exception):
    """Raised when Gemini embedding fails after retries."""


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
    single = getattr(result, "embedding", None)
    if single is not None:
        return [single]
    return []


def _values_from_embedding(emb: object) -> list[float] | None:
    values = getattr(emb, "values", None)
    if values is None and isinstance(emb, Sequence) and not isinstance(
        emb, (str, bytes)
    ):
        values = emb
    if not values:
        return None
    return list(values)


def _is_transient(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        tok in msg
        for tok in (
            "503",
            "unavailable",
            "429",
            "resource_exhausted",
            "rate",
            "timeout",
            "temporarily",
            "connection",
        )
    )


def _model_supports_multi_content_batch() -> bool:
    """
    gemini-embedding-2 currently returns 1 vector for N texts.
    gemini-embedding-001 returns one vector per text (true batch).
    """
    model = (settings.GEMINI_EMBEDDING_MODEL or "").lower()
    if "embedding-2" in model:
        return False
    return True


async def _embed_raw(
    gemini: genai.Client,
    contents: str | list[str],
    *,
    task_type: str,
) -> list[list[float]]:
    """Single API call; may return fewer vectors than inputs for some models."""
    result = await gemini.aio.models.embed_content(
        model=settings.GEMINI_EMBEDDING_MODEL,
        contents=contents,  # type: ignore[arg-type]
        config=types.EmbedContentConfig(
            task_type=task_type,
            output_dimensionality=RAG_EMBEDDING_DIM,
        ),
    )
    embeddings = _extract_embeddings(result)
    out: list[list[float]] = []
    for emb in embeddings:
        values = _values_from_embedding(emb)
        if not values:
            raise EmbeddingError("empty embedding returned")
        out.append(_normalize_embedding(values))
    return out


async def _embed_raw_with_backoff(
    gemini: genai.Client,
    contents: str | list[str],
    *,
    task_type: str,
    attempts: int = 6,
) -> list[list[float]]:
    last: Exception | None = None
    for i in range(attempts):
        try:
            return await _embed_raw(gemini, contents, task_type=task_type)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if not _is_transient(exc) or i == attempts - 1:
                raise EmbeddingError(str(exc)[:500]) from exc
            delay = min(60.0, (2**i) + random.uniform(0, 1.5))
            logger.warning(
                "embed transient error (attempt %s/%s), sleep %.1fs: %s",
                i + 1,
                attempts,
                delay,
                str(exc)[:160],
            )
            await asyncio.sleep(delay)
    assert last is not None
    raise EmbeddingError(str(last)[:500]) from last


async def _embed_one(
    gemini: genai.Client,
    text: str,
    *,
    task_type: str,
) -> list[float]:
    content = text if text.strip() else " "
    if not text.strip():
        return [0.0] * RAG_EMBEDDING_DIM
    vectors = await _embed_raw_with_backoff(gemini, content, task_type=task_type)
    if not vectors:
        raise EmbeddingError("empty embedding returned")
    return vectors[0]


async def embed_texts(
    texts: list[str],
    *,
    gemini: genai.Client | None = None,
    task_type: str = "RETRIEVAL_DOCUMENT",
) -> list[list[float]]:
    """
    Embed texts with Gemini.

    Uses multi-content batches when the model supports them; otherwise embeds
    one text at a time with light concurrency and strong 503 backoff.
    """
    if not texts:
        return []
    if not configured():
        raise EmbeddingError("GEMINI_API_KEY is not configured")

    gemini = gemini or client()
    use_batch = _model_supports_multi_content_batch()
    batch_size = max(1, settings.RAG_EMBED_BATCH_SIZE if use_batch else 1)
    out: list[list[float]] = []

    if not use_batch:
        # embedding-2: sequential-ish to avoid 503 storms (concurrency 3).
        sem = asyncio.Semaphore(3)

        async def _one(t: str) -> list[float]:
            async with sem:
                vec = await _embed_one(gemini, t, task_type=task_type)
                await asyncio.sleep(0.05)
                return vec

        # Process in windows so a failure doesn't lose the whole book mid-flight
        # when called for a small slice from the worker.
        return list(await asyncio.gather(*[_one(t) for t in texts]))

    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        contents = [t if t.strip() else " " for t in batch]
        try:
            vectors = await _embed_raw_with_backoff(
                gemini, contents, task_type=task_type
            )
        except EmbeddingError:
            # Last resort: one-by-one for this window.
            logger.warning(
                "batch embed failed; falling back to per-item for %s texts",
                len(batch),
            )
            for t in batch:
                out.append(await _embed_one(gemini, t, task_type=task_type))
            continue

        if len(vectors) != len(batch):
            logger.warning(
                "batch size mismatch (%s vs %s); per-item fallback",
                len(vectors),
                len(batch),
            )
            for t in batch:
                out.append(await _embed_one(gemini, t, task_type=task_type))
            continue

        for i, vec in enumerate(vectors):
            if not batch[i].strip():
                out.append([0.0] * RAG_EMBEDDING_DIM)
            else:
                out.append(vec)

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
    attempts: int = 4,
) -> list[list[float]]:
    last: Exception | None = None
    for i in range(attempts):
        try:
            return await embed_texts(texts, gemini=gemini, task_type=task_type)
        except EmbeddingError as exc:
            last = exc
            delay = min(45.0, (2**i) + random.uniform(0, 1))
            logger.warning(
                "embed_texts_with_retry %s/%s failed: %s (sleep %.1fs)",
                i + 1,
                attempts,
                str(exc)[:160],
                delay,
            )
            await asyncio.sleep(delay)
    assert last is not None
    raise last
