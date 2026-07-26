"""Pure tests for RAG page-aware chunking and context assembly."""

from __future__ import annotations

from app.services import pdf_text_extract, rag_chunking
from app.services.rag_chunking import RagChunkSpec
import pymupdf


def _assert_page_meta(specs: list[RagChunkSpec]) -> None:
    for s in specs:
        assert s.page_start is not None, s
        assert s.page_end is not None
        assert s.page_start <= s.page_end
        assert s.content.strip()
        assert s.chunk_index >= 0
        assert len(s.content) > 0


def test_paragraph_aware_chunking_keeps_pages():
    # Build multi-page offsets manually
    p1 = "First paragraph about rivers.\n\nSecond paragraph about deltas.\n\n"
    p2 = "Third paragraph about deserts and sand.\n\nFourth about oases.\n\n"
    p3 = "Fifth paragraph closes the chapter with a summary of climate."
    full = p1 + p2 + p3
    offsets = [(0, 1), (len(p1), 2), (len(p1) + len(p2), 3)]

    specs = rag_chunking.chunk_pages_text(full, offsets, max_chars=80, overlap=0)
    assert len(specs) >= 2
    _assert_page_meta(specs)
    # No single chunk should wildly exceed max_chars without reason
    for s in specs:
        assert len(s.content) <= 200  # generous for paragraph tails
    # Coverage: every page appears in at least one chunk's range
    pages_seen = set()
    for s in specs:
        for p in range(s.page_start or 0, (s.page_end or 0) + 1):
            pages_seen.add(p)
    assert 1 in pages_seen
    assert 2 in pages_seen or 3 in pages_seen


def test_section_heading_preference():
    text = (
        "## Chapter One Rivers\n\n"
        + ("The Nile flooded yearly. " * 30)
        + "\n\n## Chapter Two Deserts\n\n"
        + ("Sand dunes stretched forever. " * 30)
    )
    offsets = [(0, 1), (len(text) // 2, 2)]
    specs = rag_chunking.chunk_pages_text(text, offsets, max_chars=500, overlap=0)
    assert len(specs) >= 2
    titles = " ".join(s.title for s in specs)
    assert "Rivers" in titles or "Chapter" in titles
    _assert_page_meta(specs)


def test_empty_text_yields_no_chunks():
    assert rag_chunking.chunk_pages_text("", [], max_chars=100) == []
    assert rag_chunking.chunk_pages_text("   \n\n  ", [(0, 1)], max_chars=100) == []


def test_build_context_and_shape_sources():
    hits = [
        ("Nile agriculture details " * 20, 1, 1, "Intro"),
        ("Pyramids at Giza " * 20, 4, 5, "Monuments"),
    ]
    ctx = rag_chunking.build_context_from_chunks(hits, max_chars=5000)
    assert "Fonte 1" in ctx
    assert "página 1" in ctx
    assert "páginas 4-5" in ctx
    assert "Fonte 2" in ctx

    source_rows = [
        (0, 1, 1, "Intro", "short excerpt about Nile", 0.91),
        (1, 4, 5, "Monuments", "x" * 800, 0.7),
    ]
    sources = rag_chunking.shape_sources(source_rows, excerpt_chars=50)
    assert sources[0]["page_start"] == 1
    assert sources[0]["score"] == 0.91
    assert len(sources[1]["excerpt"]) <= 50
    assert sources[1]["excerpt"].endswith("…")


def test_pdf_extract_page_offsets_roundtrip():
    doc = pymupdf.open()
    for content in ("Page one alpha.", "Page two beta."):
        page = doc.new_page()
        page.insert_text((72, 72), content)
    data = doc.tobytes()
    doc.close()

    extracted = pdf_text_extract.extract_pages(data)
    assert len(extracted.pages) == 2
    assert "alpha" in extracted.full_text
    assert "beta" in extracted.full_text
    assert extracted.page_offsets[0][1] == 1
    assert any(p == 2 for _, p in extracted.page_offsets)

    specs = rag_chunking.chunk_pages_text(
        extracted.full_text, extracted.page_offsets, max_chars=50, overlap=0
    )
    assert specs
    _assert_page_meta(specs)
