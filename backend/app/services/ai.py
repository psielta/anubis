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
    "Você é um tutor de estudos focado no livro do usuário. Responda usando "
    "APENAS o documento anexado; se a resposta não estiver nele, diga isso "
    "claramente. Responda SEMPRE em português do Brasil (pt-BR), em Markdown "
    "GitHub-flavored claro (títulos, listas, negrito, tabelas, código). Não "
    "insira imagens nem use a sintaxe de imagem do Markdown (![...](...)); o "
    "usuário já vê as figuras no documento, então descreva-as em texto quando "
    "precisar se referir a elas."
)

_TASK_PROMPTS = {
    "summary": (
        "Resuma este documento para estudo: as ideias principais como títulos "
        "Markdown com tópicos e, ao final, uma breve lista '## Principais "
        "conclusões'. Escreva em português do Brasil."
    ),
    "flashcards": (
        "Crie flashcards de estudo a partir deste documento como uma lista "
        "Markdown. Para cada cartão use duas linhas: '**P:** <pergunta>' e "
        "depois '**R:** <resposta>'. Escreva em português do Brasil."
    ),
}

_EXERCISE_PROMPTS = {
    "statement": (
        "O usuário recortou um exercício da página anexada. Aqui está o texto "
        "bruto extraído do recorte (pode estar ruidoso, fora de ordem ou com "
        "caracteres trocados):\n\n"
        '"""\n{statement}\n"""\n\n'
        "Transcreva o enunciado fielmente a partir da IMAGEM da página anexada, "
        "usando o texto acima apenas como apoio. Corrija caracteres corrompidos "
        "ou ilegíveis (como '�'), em especial letras gregas (α, β, θ, π). "
        "Quando houver vários itens (a, b, c, ...), coloque CADA item em sua "
        "própria linha. Represente toda a matemática em LaTeX: $...$ para inline "
        "(ex.: $\\alpha$, $2x - 10^\\circ$) e $$...$$ para equações em destaque. "
        "NÃO resolva. Devolva apenas o enunciado limpo em Markdown, sem "
        "preâmbulo. Escreva em português do Brasil."
    ),
    "hint": (
        "O usuário está resolvendo este exercício, recortado da página anexada:\n\n"
        '"""\n{statement}\n"""\n\n'
        "Dê uma dica guiada, passo a passo, que conduza à solução sem revelar a "
        "resposta final de imediato. Use Markdown e LaTeX ($...$). Termine "
        "dizendo o que calcular em seguida. Escreva em português do Brasil."
    ),
    "review": (
        "O usuário está resolvendo este exercício, recortado da página anexada:\n\n"
        '"""\n{statement}\n"""\n\n'
        "Aqui está a resolução tentada pelo usuário (código LaTeX):\n\n"
        '"""\n{work}\n"""\n\n'
        "Revise: verifique cada passo, aponte os erros e diga se a resposta "
        "final está correta. Seja específico, conciso e encorajador. Use "
        "Markdown e LaTeX. Escreva em português do Brasil."
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
        focus = (question or "").strip() or "Explique esta passagem no seu contexto."
        prompt = (
            "O usuário destacou esta passagem do documento:\n\n"
            f'"""\n{selection}\n"""\n\n'
            f"{focus}\n\n"
            "Responda especificamente sobre ESTA passagem; use o restante das "
            "páginas anexadas apenas como contexto. Responda em português do Brasil."
        )
    elif kind == "chat":
        fallback = "Explique os pontos principais deste documento."
        prompt = (question or "").strip() or fallback
    else:
        prompt = _TASK_PROMPTS[kind]

    async for item in _stream_prompt(gemini, part, prompt):
        yield item


async def stream_exercise_reply(
    gemini: genai.Client,
    part: Any,
    *,
    mode: str,
    statement: str,
    work: str,
    question: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """Yield ('thinking'|'answer', chunk) for an exercise-resolution AI action."""
    prompt = _EXERCISE_PROMPTS[mode].format(
        statement=statement.strip() or "(no text extracted)",
        work=work.strip() or "(empty)",
    )
    if question and question.strip():
        prompt += f"\n\nO usuário também pergunta: {question.strip()}"
    async for item in _stream_prompt(gemini, part, prompt):
        yield item


async def _stream_prompt(
    gemini: genai.Client, part: Any, prompt: str
) -> AsyncIterator[tuple[str, str]]:
    """Stream one prompt against the attached PDF part, splitting thinking/answer."""
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


_TRANSLATE_SYSTEM_INSTRUCTION = (
    "Você é um tradutor especialista. Traduza a página de PDF anexada para "
    "português do Brasil (pt-BR) com naturalidade e fidelidade ao significado. "
    "Devolva APENAS a tradução em Markdown GitHub-flavored, espelhando o layout "
    "original: mantenha títulos, listas, tabelas, negrito/itálico, citações e "
    "notas de rodapé; mantenha blocos e trechos de código sem traduzir; "
    "represente fórmulas como LaTeX ($...$ inline, $$...$$ em bloco) e preserve a "
    "ordem de leitura de páginas em colunas. Não adicione comentários, títulos "
    "extras, nem cerque a saída inteira em crases. Não gere imagens nem use a "
    "sintaxe de imagem do Markdown (![...](...)); para uma figura, escreva uma "
    "breve legenda em texto (o usuário vê a imagem original no PDF)."
)


async def stream_translation(gemini: genai.Client, part: Any) -> AsyncIterator[str]:
    """Yield Markdown chunks translating the attached PDF page into pt-BR."""
    config = types.GenerateContentConfig(
        system_instruction=_TRANSLATE_SYSTEM_INSTRUCTION,
    )
    stream = await gemini.aio.models.generate_content_stream(
        model=settings.GEMINI_MODEL,
        contents=[part, "Traduza esta página para português do Brasil em Markdown."],
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
            if text:
                yield text
