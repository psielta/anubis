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


def _fence_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    pos = 0
    while pos < len(text):
        open_idx = text.find("```", pos)
        if open_idx == -1:
            break
        close_idx = text.find("```", open_idx + 3)
        if close_idx == -1:
            spans.append((open_idx, len(text)))
            break
        spans.append((open_idx, close_idx + 3))
        pos = close_idx + 3
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
    return _fence_spans(text) + _table_spans(text)


def _span_containing(spans: list[tuple[int, int]], pos: int) -> tuple[int, int] | None:
    for start, end in spans:
        if start <= pos < end:
            return start, end
    return None


def _fences_balanced(text: str) -> bool:
    return text.count("```") % 2 == 0


def _paragraph_split(text: str, start: int, before: int) -> int | None:
    for sep in ("\n\n", "\n", " "):
        idx = text.rfind(sep, start, before)
        if idx != -1:
            candidate = idx + len(sep)
            if candidate > start:
                return candidate
    return None


def _safe_split_point(text: str, start: int, target_end: int) -> int:
    """Never split inside a code fence or markdown table."""
    if target_end >= len(text):
        return len(text)

    protected = _protected_spans(text)
    hit = _span_containing(protected, target_end - 1)
    if hit is None:
        hit = _span_containing(protected, target_end)

    if hit:
        span_start, span_end = hit
        if span_start > start:
            pre = _paragraph_split(text, start, span_start)
            if pre is not None and _fences_balanced(text[start:pre]):
                return pre
            return span_start
        return span_end

    search_from = min(target_end, len(text))
    for sep in ("\n\n", "\n", " "):
        idx = text.rfind(sep, start, search_from)
        while idx != -1:
            candidate = idx + len(sep)
            if candidate > start and _fences_balanced(text[start:candidate]):
                trailing = _span_containing(protected, candidate - 1)
                if trailing is None:
                    return candidate
            idx = text.rfind(sep, start, idx)

    trailing = _span_containing(protected, search_from - 1)
    if trailing:
        return trailing[1]
    return search_from if search_from > start else len(text)


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
            if split_at <= local:
                split_at = target
        else:
            split_at = len(text)

        piece = text[local:split_at]
        assert _fences_balanced(piece), "chunk must not split inside code fence"

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
        if len(section) <= cap and _fences_balanced(section):
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