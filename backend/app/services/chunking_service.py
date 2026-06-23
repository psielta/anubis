"""Pure markdown chunking with heading preference and size fallback."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.config import settings

_HEADING_RE = re.compile(r"^(#{1,2})\s+(.+)$", re.MULTILINE)
_FENCE_MARKER = "```"


@dataclass(frozen=True)
class ChunkSpec:
    chunk_index: int
    title: str
    content_markdown: str
    char_start: int
    char_end: int
    page_start: int | None
    page_end: int | None


def _pages_for_range(
    start: int, end: int, page_offsets: list[tuple[int, int]]
) -> tuple[int | None, int | None]:
    if not page_offsets:
        return None, None
    pages = [p for off, p in page_offsets if start <= off < end]
    if not pages and page_offsets:
        if start < page_offsets[0][0]:
            pages = [1]
        else:
            pages = [page_offsets[-1][1]]
    if not pages:
        return None, None
    return min(pages), max(pages)


def _fence_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    pos = 0
    while pos < len(text):
        open_idx = text.find(_FENCE_MARKER, pos)
        if open_idx == -1:
            break
        close_idx = text.find(_FENCE_MARKER, open_idx + len(_FENCE_MARKER))
        if close_idx == -1:
            spans.append((open_idx, len(text)))
            break
        spans.append((open_idx, close_idx + len(_FENCE_MARKER)))
        pos = close_idx + len(_FENCE_MARKER)
    return spans


def _is_table_line(line: str) -> bool:
    s = line.strip()
    return bool(s) and s.startswith("|") and s.endswith("|")


def _table_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    line_start = 0
    in_table = False
    tbl_start = 0
    while line_start <= len(text):
        line_end = text.find("\n", line_start)
        if line_end == -1:
            line_end = len(text)
        line = text[line_start:line_end]
        if _is_table_line(line):
            if not in_table:
                tbl_start = line_start
                in_table = True
        elif in_table:
            spans.append((tbl_start, line_start))
            in_table = False
        if line_end == len(text):
            if in_table:
                spans.append((tbl_start, len(text)))
            break
        line_start = line_end + 1
    return spans


def _protected_spans(text: str) -> list[tuple[int, int]]:
    return sorted(_fence_spans(text) + _table_spans(text))


def _span_containing(spans: list[tuple[int, int]], pos: int) -> tuple[int, int] | None:
    for start, end in spans:
        if start <= pos < end:
            return start, end
    return None


def _chunk_fences_closed(text: str) -> bool:
    """True when the chunk does not end inside an open code fence."""
    in_fence = False
    pos = 0
    while pos < len(text):
        idx = text.find(_FENCE_MARKER, pos)
        if idx == -1:
            break
        in_fence = not in_fence
        pos = idx + len(_FENCE_MARKER)
    return not in_fence


def _paragraph_split(text: str, start: int, before: int) -> int | None:
    for sep in ("\n\n", "\n", " "):
        idx = text.rfind(sep, start, before)
        if idx != -1:
            candidate = idx + len(sep)
            if candidate > start:
                return candidate
    return None


def _compute_split(text: str, start: int, window_end: int) -> int:
    """
    Exclusive end index for the next chunk.

    Code fences and markdown tables are atomic: they are never bisected.
    Blocks larger than the window produce an oversized chunk.
    """
    if window_end >= len(text):
        return len(text)

    protected = _protected_spans(text)

    active = _span_containing(protected, start)
    if active and active[0] <= start < active[1]:
        return active[1]

    for span_start, span_end in protected:
        if span_end <= start:
            continue
        if span_start >= window_end:
            break
        # Protected block begins inside this window — take the whole block.
        if span_start >= start and span_start < window_end < span_end:
            return span_end
        # Window would cut into a later block — end before it.
        if span_start > start and span_start < window_end:
            pre = _paragraph_split(text, start, span_start)
            return pre if pre and pre > start else span_start

    candidate = _paragraph_split(text, start, window_end)
    if candidate and candidate > start:
        if _span_containing(protected, candidate - 1) is None:
            return candidate
    return window_end


def _validate_chunk_piece(piece: str) -> None:
    if not _chunk_fences_closed(piece):
        raise ValueError("chunk splits inside a code fence")


def _split_by_size(
    text: str,
    global_start: int,
    page_offsets: list[tuple[int, int]],
    max_chars: int,
    title: str,
    start_index: int,
) -> tuple[list[ChunkSpec], int]:
    chunks: list[ChunkSpec] = []
    local = 0
    idx = start_index
    part_num = 1
    base_title = title
    while local < len(text):
        window_end = min(local + max_chars, len(text))
        split_at = (
            _compute_split(text, local, window_end)
            if window_end < len(text)
            else len(text)
        )
        if split_at <= local:
            split_at = min(local + max_chars, len(text))
            if split_at <= local:
                split_at = len(text)

        piece = text[local:split_at]
        _validate_chunk_piece(piece)

        g_start = global_start + local
        g_end = global_start + split_at
        chunk_title = base_title if part_num == 1 else f"{base_title} (parte {part_num})"
        ps, pe = _pages_for_range(g_start, g_end, page_offsets)
        chunks.append(
            ChunkSpec(
                chunk_index=idx,
                title=chunk_title,
                content_markdown=piece,
                char_start=g_start,
                char_end=g_end,
                page_start=ps,
                page_end=pe,
            )
        )
        idx += 1
        part_num += 1
        local = split_at
    return chunks, idx


def chunk_markdown(
    full_md: str,
    page_offsets: list[tuple[int, int]],
    *,
    max_chars: int | None = None,
) -> list[ChunkSpec]:
    """
    Split markdown into sequential chunks.

    content_length unit for storage is Python len() = Unicode code points (chars).
    Indivisible code fences/tables may produce chunks larger than max_chars.
    """
    cap = max_chars or settings.PDF_CONVERSION_CHUNK_MAX_CHARS
    if not full_md.strip():
        return []

    headings = list(_HEADING_RE.finditer(full_md))
    h12 = [m for m in headings if len(m.group(1)) <= 2]

    chunks: list[ChunkSpec] = []
    next_index = 0

    if not h12:
        specs, _ = _split_by_size(
            full_md, 0, page_offsets, cap, "Seção 1", next_index
        )
        return specs

    first = h12[0]
    if first.start() > 0:
        preamble = full_md[: first.start()]
        if preamble.strip():
            specs, next_index = _split_by_size(
                preamble, 0, page_offsets, cap, "Introdução", next_index
            )
            chunks.extend(specs)

    for i, match in enumerate(h12):
        section_start = match.start()
        section_end = h12[i + 1].start() if i + 1 < len(h12) else len(full_md)
        section = full_md[section_start:section_end]
        title = match.group(2).strip() or f"Seção {next_index + 1}"
        if len(section) <= cap and _chunk_fences_closed(section):
            _validate_chunk_piece(section)
            ps, pe = _pages_for_range(section_start, section_end, page_offsets)
            chunks.append(
                ChunkSpec(
                    chunk_index=next_index,
                    title=title,
                    content_markdown=section,
                    char_start=section_start,
                    char_end=section_end,
                    page_start=ps,
                    page_end=pe,
                )
            )
            next_index += 1
        else:
            specs, next_index = _split_by_size(
                section, section_start, page_offsets, cap, title, next_index
            )
            chunks.extend(specs)

    return chunks