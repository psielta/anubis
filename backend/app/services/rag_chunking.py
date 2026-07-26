"""Page-aware intelligent chunking for RAG (paragraph/section preference)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.config import settings

_HEADING_RE = re.compile(
    r"^(?:"
    r"#{1,3}\s+.+"  # markdown headings
    r"|(?:CHAPTER|Chapter|Capítulo|CAPÍTULO|Seção|SEÇÃO|Section|SECTION)"
    r"\s+[\dIVXLC]+[^\n]*"  # chapter-like labels
    r"|(?:[A-ZÁÉÍÓÚÂÊÔÃÕ][A-ZÁÉÍÓÚÂÊÔÃÕ\s\d\.\-]{8,80})"  # ALL-CAPS short title lines
    r")$",
    re.MULTILINE,
)


@dataclass(frozen=True)
class RagChunkSpec:
    chunk_index: int
    title: str
    content: str
    page_start: int | None
    page_end: int | None
    char_start: int
    char_end: int


def _pages_for_range(
    start: int, end: int, page_offsets: list[tuple[int, int]]
) -> tuple[int | None, int | None]:
    if not page_offsets:
        return None, None
    pages: list[int] = []
    for i, (off, page) in enumerate(page_offsets):
        next_off = (
            page_offsets[i + 1][0] if i + 1 < len(page_offsets) else 10**12
        )
        # Page contributes to [off, next_off)
        if end > off and start < next_off:
            pages.append(page)
    if not pages:
        # Fall back: nearest page at or before start.
        prev = [p for off, p in page_offsets if off <= start]
        if prev:
            return prev[-1], prev[-1]
        return page_offsets[0][1], page_offsets[0][1]
    return min(pages), max(pages)


def _paragraph_split(text: str, start: int, before: int) -> int | None:
    """Prefer splitting on paragraph, then line, then word boundary."""
    for sep in ("\n\n", "\n", ". ", " "):
        idx = text.rfind(sep, start, before)
        if idx != -1:
            candidate = idx + len(sep)
            if candidate > start:
                return candidate
    return None


def _split_window(
    text: str,
    global_start: int,
    page_offsets: list[tuple[int, int]],
    max_chars: int,
    title: str,
    start_index: int,
    overlap: int,
) -> tuple[list[RagChunkSpec], int]:
    chunks: list[RagChunkSpec] = []
    local = 0
    idx = start_index
    part = 1
    while local < len(text):
        window_end = min(local + max_chars, len(text))
        if window_end >= len(text):
            split_at = len(text)
        else:
            split_at = _paragraph_split(text, local, window_end) or window_end
            if split_at <= local:
                split_at = window_end

        piece = text[local:split_at].strip()
        if piece:
            g_start = global_start + local
            g_end = global_start + split_at
            ps, pe = _pages_for_range(g_start, g_end, page_offsets)
            chunk_title = title if part == 1 else f"{title} (parte {part})"
            chunks.append(
                RagChunkSpec(
                    chunk_index=idx,
                    title=chunk_title,
                    content=piece,
                    page_start=ps,
                    page_end=pe,
                    char_start=g_start,
                    char_end=g_end,
                )
            )
            idx += 1
            part += 1

        if split_at >= len(text):
            break
        # Overlap for continuity across large sections.
        next_local = max(local + 1, split_at - overlap) if overlap > 0 else split_at
        if next_local <= local:
            next_local = split_at
        local = next_local
    return chunks, idx


def chunk_pages_text(
    full_text: str,
    page_offsets: list[tuple[int, int]],
    *,
    max_chars: int | None = None,
    overlap: int | None = None,
) -> list[RagChunkSpec]:
    """
    Split extracted PDF text into RAG chunks.

    Prefers section-like headings when present; otherwise paragraph-aware
    size windows. Always preserves page_start/page_end metadata.
    """
    cap = max_chars if max_chars is not None else settings.RAG_CHUNK_MAX_CHARS
    ov = overlap if overlap is not None else settings.RAG_CHUNK_OVERLAP_CHARS
    text = full_text or ""
    if not text.strip():
        return []

    headings = list(_HEADING_RE.finditer(text))
    chunks: list[RagChunkSpec] = []
    next_index = 0

    if not headings:
        specs, _ = _split_window(
            text, 0, page_offsets, cap, "Seção 1", next_index, ov
        )
        return specs

    first = headings[0]
    if first.start() > 0:
        preamble = text[: first.start()]
        if preamble.strip():
            specs, next_index = _split_window(
                preamble, 0, page_offsets, cap, "Introdução", next_index, ov
            )
            chunks.extend(specs)

    for i, match in enumerate(headings):
        section_start = match.start()
        section_end = (
            headings[i + 1].start() if i + 1 < len(headings) else len(text)
        )
        section = text[section_start:section_end]
        title_line = match.group(0).strip()
        title = re.sub(r"^#+\s*", "", title_line)[:200] or f"Seção {next_index + 1}"
        if len(section) <= cap:
            piece = section.strip()
            if piece:
                ps, pe = _pages_for_range(section_start, section_end, page_offsets)
                chunks.append(
                    RagChunkSpec(
                        chunk_index=next_index,
                        title=title,
                        content=piece,
                        page_start=ps,
                        page_end=pe,
                        char_start=section_start,
                        char_end=section_end,
                    )
                )
                next_index += 1
        else:
            specs, next_index = _split_window(
                section,
                section_start,
                page_offsets,
                cap,
                title,
                next_index,
                ov,
            )
            chunks.extend(specs)

    # Re-index densely in case empty pieces were skipped.
    return [
        RagChunkSpec(
            chunk_index=i,
            title=c.title,
            content=c.content,
            page_start=c.page_start,
            page_end=c.page_end,
            char_start=c.char_start,
            char_end=c.char_end,
        )
        for i, c in enumerate(chunks)
    ]


def build_context_from_chunks(
    hits: list[tuple[str, int | None, int | None, str]],
    *,
    max_chars: int = 12000,
) -> str:
    """
    Pure helper: assemble LLM context from retrieved chunk texts.

    hits: list of (content, page_start, page_end, title)
    """
    parts: list[str] = []
    used = 0
    for i, (content, page_start, page_end, title) in enumerate(hits, start=1):
        if page_start is not None and page_end is not None and page_start != page_end:
            loc = f"páginas {page_start}-{page_end}"
        elif page_start is not None:
            loc = f"página {page_start}"
        else:
            loc = "página desconhecida"
        header = f"[Fonte {i} | {loc} | {title}]"
        block = f"{header}\n{content.strip()}"
        if used + len(block) + 2 > max_chars and parts:
            break
        parts.append(block)
        used += len(block) + 2
    return "\n\n".join(parts)


def shape_sources(
    hits: list[tuple[int, int | None, int | None, str, str, float | None]],
    *,
    excerpt_chars: int = 400,
) -> list[dict]:
    """
    Pure helper: map retrieved rows to source DTOs.

    hits: (chunk_index, page_start, page_end, title, content, score)
    """
    sources: list[dict] = []
    for chunk_index, page_start, page_end, title, content, score in hits:
        excerpt = content.strip()
        if len(excerpt) > excerpt_chars:
            excerpt = excerpt[: excerpt_chars - 1].rstrip() + "…"
        sources.append(
            {
                "chunk_index": chunk_index,
                "page_start": page_start,
                "page_end": page_end,
                "title": title or "",
                "excerpt": excerpt,
                "score": score,
            }
        )
    return sources
