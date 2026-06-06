"""Gemini-backed study assistant: builds a PDF part and streams replies.

Grounded in the book's PDF (document understanding), always answering in
Markdown, and surfacing the model's thinking so the API layer can stream it.
"""

import asyncio
import io
from collections.abc import AsyncIterator
from typing import Any

import pymupdf
from google import genai
from google.genai import types

from app.core.config import settings

_SYSTEM_INSTRUCTION = (
    "You are a focused study tutor for the user's book. Answer using ONLY the "
    "attached document; if the answer is not in it, say so plainly. Always reply "
    "in clear GitHub-flavored Markdown (headings, lists, bold, tables, code)."
)

_TASK_PROMPTS = {
    "summary": (
        "Summarize this document for studying: the main ideas as Markdown headings "
        "with bullet points, then a short '## Key takeaways' list."
    ),
    "flashcards": (
        "Create study flashcards from this document as a Markdown list. For each "
        "card use two lines: '**Q:** <question>' then '**A:** <answer>'."
    ),
}


def configured() -> bool:
    return bool(settings.GEMINI_API_KEY)


def client() -> genai.Client:
    return genai.Client(api_key=settings.GEMINI_API_KEY)


def inline_part(data: bytes) -> types.Part:
    return types.Part.from_bytes(data=data, mime_type="application/pdf")


async def extract_pages(data: bytes, page_from: int, page_to: int) -> bytes:
    """Extract a 1-based inclusive page range into a new small PDF (off-loop)."""

    def _run() -> bytes:
        doc = pymupdf.open(stream=data, filetype="pdf")
        try:
            count = doc.page_count
            start = max(1, page_from) - 1
            end = min(count, page_to) - 1
            if end < start:
                end = start
            out = pymupdf.open()
            try:
                out.insert_pdf(doc, from_page=start, to_page=end)
                return out.tobytes()
            finally:
                out.close()
        finally:
            doc.close()

    return await asyncio.to_thread(_run)


async def get_file(gemini: genai.Client, name: str) -> Any | None:
    try:
        return await gemini.aio.files.get(name=name)
    except Exception:
        return None


async def upload_pdf(gemini: genai.Client, data: bytes, book_id: int) -> Any:
    """Upload via the File API with an ASCII-safe display name."""
    return await gemini.aio.files.upload(
        file=io.BytesIO(data),
        config=types.UploadFileConfig(
            mime_type="application/pdf", display_name=f"book-{book_id}.pdf"
        ),
    )


async def stream_reply(
    gemini: genai.Client,
    part: Any,
    kind: str,
    question: str | None,
    selection: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """Yield ('thinking'|'answer', text_chunk) from a streamed Gemini reply."""
    if selection:
        focus = (question or "").strip() or "Explain this passage in its context."
        prompt = (
            "The user highlighted this passage from the document:\n\n"
            f'"""\n{selection}\n"""\n\n'
            f"{focus}\n\n"
            "Answer about THIS passage specifically; use the rest of the attached "
            "pages only for context."
        )
    elif kind == "chat":
        prompt = (question or "").strip() or "Explain the key points of this document."
    else:
        prompt = _TASK_PROMPTS[kind]

    config = types.GenerateContentConfig(
        system_instruction=_SYSTEM_INSTRUCTION,
        thinking_config=types.ThinkingConfig(include_thoughts=True),
    )

    stream = await gemini.aio.models.generate_content_stream(
        model=settings.GEMINI_MODEL,
        contents=[part, prompt],
        config=config,
    )
    async for chunk in stream:
        candidates = chunk.candidates or []
        if not candidates:
            continue
        content = candidates[0].content
        if content is None or not content.parts:
            continue
        for piece in content.parts:
            text = getattr(piece, "text", None)
            if not text:
                continue
            yield ("thinking" if getattr(piece, "thought", False) else "answer", text)
