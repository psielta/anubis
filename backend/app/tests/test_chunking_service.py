"""Unit tests for chunking_service (pure functions, no DB)."""

from __future__ import annotations

from app.services import chunking_service as cs
from app.services.chunking_service import ChunkSpec

_FENCE = "```"


def _assert_chunks_integrity(
    source: str, specs: list[ChunkSpec], *, max_chars: int | None = None
) -> None:
    assert "".join(s.content_markdown for s in specs) == source
    indices = [s.chunk_index for s in specs]
    assert indices == list(range(len(specs)))
    for spec in specs:
        assert cs._chunk_fences_closed(spec.content_markdown), (
            f"chunk {spec.chunk_index} ends inside a fence: "
            f"markers={spec.content_markdown.count(_FENCE)}"
        )
        if max_chars is not None:
            # Only non-fence-only chunks are bounded; fence blocks may exceed cap.
            if spec.content_markdown.count(_FENCE) == 0:
                assert len(spec.content_markdown) <= max_chars + 50


def test_no_headings_size_based():
    text = "Paragraph one.\n\n" * 400
    specs = cs.chunk_markdown(text, [(0, 1)], max_chars=2000)
    assert len(specs) >= 2
    _assert_chunks_integrity(text, specs, max_chars=2000)
    assert specs[0].title == "Seção 1"


def test_fence_not_split_across_chunks():
    fence = _FENCE + "python\n" + ("x = 1\n" * 200) + _FENCE + "\n\n"
    text = fence + ("tail paragraph.\n\n" * 50)
    specs = cs.chunk_markdown(text, [(0, 1)], max_chars=500)
    assert len(specs) >= 2
    _assert_chunks_integrity(text, specs)
    fence_counts = [s.content_markdown.count(_FENCE) for s in specs]
    assert all(c % 2 == 0 for c in fence_counts), fence_counts
    assert 2 in fence_counts or any(c >= 2 for c in fence_counts)


def test_oversized_fence_stays_in_single_chunk():
    fence = _FENCE + "\n" + ("line inside fence\n" * 400) + _FENCE + "\n\nafter"
    specs = cs.chunk_markdown(fence, [(0, 1)], max_chars=200)
    fence_chunks = [s for s in specs if _FENCE in s.content_markdown]
    assert len(fence_chunks) == 1, [s.content_markdown.count(_FENCE) for s in specs]
    assert fence_chunks[0].content_markdown.count(_FENCE) == 2
    _assert_chunks_integrity(fence, specs)


def test_table_rows_not_bisected():
    header = "| Col A | Col B |\n| --- | --- |\n"
    rows = "".join(f"| row {i} | val {i} |\n" for i in range(80))
    text = header + rows + "\n\nAfter table.\n" * 30
    specs = cs.chunk_markdown(text, [(0, 1)], max_chars=600)
    _assert_chunks_integrity(text, specs)
    for spec in specs:
        for line in spec.content_markdown.split("\n"):
            if line.strip().startswith("|"):
                assert line.strip().endswith("|"), line


def test_preamble_before_first_heading_is_chunk_zero():
    text = "Intro sem heading.\n\n" + "## Capítulo\n\nCorpo longo.\n" * 30
    specs = cs.chunk_markdown(text, [(0, 1)], max_chars=80)
    assert specs[0].title == "Introdução"
    _assert_chunks_integrity(text, specs)