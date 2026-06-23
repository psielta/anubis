"""Pure markdown chunking with heading preference and size fallback."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.config import settings

_HEADING_RE = re.compile(r"^(#{1,2})\s+(.+)$", re.MULTILINE)


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


def _inside_fence(text: str, pos: int) -> bool:
    return text[:pos].count("```") % 2 == 1


def _is_table_line(line: str) -> bool:
    s = line.strip()
    return bool(s) and s.startswith("|") and s.endswith("|")


def _table_span_at(text: str, pos: int) -> tuple[int, int] | None:
    """Return (start, end) char span of markdown table containing pos."""
    line_start = text.rfind("\n", 0, pos) + 1
    line_end = text.find("\n", pos)
    if line_end == -1:
        line_end = len(text)
    line = text[line_start:line_end]
    if not _is_table_line(line):
        return None

    tbl_start = line_start
    while tbl_start > 0:
        prev_end = tbl_start - 1
        prev_start = text.rfind("\n", 0, prev_end) + 1
        prev_line = text[prev_start:prev_end]
        if _is_table_line(prev_line):
            tbl_start = prev_start
        else:
            break

    tbl_end = line_end
    while tbl_end < len(text):
        next_start = tbl_end + 1 if tbl_end < len(text) else len(text)
        next_end = text.find("\n", next_start)
        if next_end == -1:
            next_end = len(text)
        next_line = text[next_start:next_end]
        if _is_table_line(next_line):
            tbl_end = next_end
        else:
            break
    return tbl_start, tbl_end


def _fence_span_at(text: str, pos: int) -> tuple[int, int] | None:
    if not _inside_fence(text, pos):
        return None
    open_fence = text.rfind("```", 0, pos)
    close_fence = text.find("```", pos)
    if open_fence == -1:
        return None
    if close_fence == -1:
        return open_fence, len(text)
    return open_fence, close_fence + 3


def _adjust_split(text: str, start: int, split_at: int) -> int:
    """Move split point out of code fences and tables."""
    if split_at >= len(text):
        return len(text)

    fence = _fence_span_at(text, split_at)
    if fence:
        _, end = fence
        return end

    table = _table_span_at(text, split_at)
    if table:
        _, end = table
        return end

    if _inside_fence(text, split_at) or (
        _table_span_at(text, split_at) is not None
    ):
        return split_at
    return split_at


def _safe_split_point(text: str, start: int, target_end: int) -> int:
    if target_end >= len(text):
        return len(text)
    search_from = min(target_end, len(text))
    for sep in ("\n\n", "\n", " "):
        idx = text.rfind(sep, start, search_from)
        while idx != -1:
            split_at = _adjust_split(text, start, idx + len(sep))
            if split_at > start and split_at <= len(text):
                if not _inside_fence(text, split_at - 1):
                    tbl = _table_span_at(text, split_at - 1)
                    if tbl is None:
                        return split_at
            idx = text.rfind(sep, start, idx)
    split_at = _adjust_split(text, start, search_from)
    return split_at if split_at > start else search_from


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
        target = min(local + max_chars, len(text))
        if target < len(text):
            split_at = _safe_split_point(text, local, target)
        else:
            split_at = len(text)
        piece = text[local:split_at]
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
        if len(section) <= cap:
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