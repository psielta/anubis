import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

// onInput fires on every keystroke; persist on a pause instead.
const EMIT_DEBOUNCE_MS = 600;

// KaTeX's stylesheet is served as a static asset and pulled in only when the
// editor first mounts, so it stays out of the initial bundle (same approach as
// the note editor).
let katexCssRequested = false;
function ensureKatexCss(): void {
  if (katexCssRequested || document.querySelector('link[data-katex]')) {
    katexCssRequested = true;
    return;
  }
  katexCssRequested = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/katex/katex.min.css';
  link.setAttribute('data-katex', '');
  document.head.appendChild(link);
}

interface KatexRenderOptions {
  displayMode?: boolean;
  throwOnError?: boolean;
}
type KatexRenderToString = (tex: string, options?: KatexRenderOptions) => string;

/** A toolbar button that inserts `snippet` at the caret. */
export interface LatexToolbarItem {
  label: string;
  snippet: string;
  title: string;
  /** Caret offset inside the snippet; defaults to inside the first `{}`. */
  caret?: number;
}
export interface LatexToolbarGroup {
  name: string;
  items: LatexToolbarItem[];
}

// A Lagrida-style palette: each button drops a LaTeX snippet at the caret so the
// user never has to memorise commands. `{}` marks where the caret lands (and
// wraps the current selection); a few items pin an explicit caret offset.
const TOOLBAR: LatexToolbarGroup[] = [
  {
    name: 'Estrutura',
    items: [
      { label: 'xⁿ', snippet: 'x^{}', title: 'Expoente: x^{n}' },
      { label: 'xₙ', snippet: 'x_{}', title: 'Índice: x_{n}' },
      { label: 'a/b', snippet: '\\frac{}{}', title: 'Fração: \\frac{a}{b}' },
      { label: '√', snippet: '\\sqrt{}', title: 'Raiz: \\sqrt{x}' },
      { label: 'ⁿ√', snippet: '\\sqrt[n]{}', title: 'Raiz n-ésima: \\sqrt[n]{x}' },
    ],
  },
  {
    name: 'Operadores',
    items: [
      { label: '∑', snippet: '\\sum_{}^{}', title: 'Somatório: \\sum_{i=1}^{n}' },
      { label: '∏', snippet: '\\prod_{}^{}', title: 'Produtório: \\prod_{i=1}^{n}' },
      { label: '∫', snippet: '\\int_{}^{}', title: 'Integral: \\int_{a}^{b}' },
      { label: 'lim', snippet: '\\lim_{}', title: 'Limite: \\lim_{x \\to 0}' },
    ],
  },
  {
    name: 'Grego',
    items: [
      { label: 'α', snippet: '\\alpha', title: '\\alpha' },
      { label: 'β', snippet: '\\beta', title: '\\beta' },
      { label: 'γ', snippet: '\\gamma', title: '\\gamma' },
      { label: 'δ', snippet: '\\delta', title: '\\delta' },
      { label: 'θ', snippet: '\\theta', title: '\\theta' },
      { label: 'λ', snippet: '\\lambda', title: '\\lambda' },
      { label: 'μ', snippet: '\\mu', title: '\\mu' },
      { label: 'π', snippet: '\\pi', title: '\\pi' },
      { label: 'σ', snippet: '\\sigma', title: '\\sigma' },
      { label: 'φ', snippet: '\\phi', title: '\\phi' },
      { label: 'ω', snippet: '\\omega', title: '\\omega' },
      { label: 'Δ', snippet: '\\Delta', title: '\\Delta' },
      { label: 'Σ', snippet: '\\Sigma', title: '\\Sigma' },
      { label: 'Ω', snippet: '\\Omega', title: '\\Omega' },
    ],
  },
  {
    name: 'Relações',
    items: [
      { label: '≤', snippet: '\\leq', title: '\\leq' },
      { label: '≥', snippet: '\\geq', title: '\\geq' },
      { label: '≠', snippet: '\\neq', title: '\\neq' },
      { label: '≈', snippet: '\\approx', title: '\\approx' },
      { label: '≡', snippet: '\\equiv', title: '\\equiv' },
      { label: '±', snippet: '\\pm', title: '\\pm' },
      { label: '×', snippet: '\\times', title: '\\times' },
      { label: '⋅', snippet: '\\cdot', title: '\\cdot' },
      { label: '∼', snippet: '\\sim', title: '\\sim' },
      { label: '∝', snippet: '\\propto', title: '\\propto' },
    ],
  },
  {
    name: 'Setas',
    items: [
      { label: '→', snippet: '\\to', title: '\\to' },
      { label: '⇒', snippet: '\\Rightarrow', title: '\\Rightarrow' },
      { label: '↔', snippet: '\\leftrightarrow', title: '\\leftrightarrow' },
      { label: '↦', snippet: '\\mapsto', title: '\\mapsto' },
    ],
  },
  {
    name: 'Conjuntos',
    items: [
      { label: '∈', snippet: '\\in', title: '\\in' },
      { label: '∉', snippet: '\\notin', title: '\\notin' },
      { label: '⊂', snippet: '\\subset', title: '\\subset' },
      { label: '∪', snippet: '\\cup', title: '\\cup' },
      { label: '∩', snippet: '\\cap', title: '\\cap' },
      { label: '∀', snippet: '\\forall', title: '\\forall' },
      { label: '∃', snippet: '\\exists', title: '\\exists' },
      { label: '∅', snippet: '\\emptyset', title: '\\emptyset' },
      { label: 'ℝ', snippet: '\\mathbb{R}', title: '\\mathbb{R}' },
    ],
  },
  {
    name: 'Delimitadores',
    items: [
      { label: '( )', snippet: '\\left( \\right)', title: 'Parênteses', caret: 7 },
      { label: '[ ]', snippet: '\\left[ \\right]', title: 'Colchetes', caret: 7 },
      { label: '{ }', snippet: '\\left\\{ \\right\\}', title: 'Chaves', caret: 8 },
      { label: '| |', snippet: '\\left| \\right|', title: 'Módulo', caret: 7 },
    ],
  },
  {
    name: 'Ambientes',
    items: [
      {
        label: 'matriz',
        snippet: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
        title: 'Matriz entre parênteses',
      },
      {
        label: 'casos',
        snippet: '\\begin{cases} a & x < 0 \\\\ b & x \\geq 0 \\end{cases}',
        title: 'Definição por casos',
      },
      {
        label: 'alinhar',
        snippet: '\\begin{aligned}\n  a &= b \\\\\n  &= c\n\\end{aligned}',
        title: 'Equações alinhadas',
      },
    ],
  },
  {
    name: 'Funções',
    items: [
      { label: 'sin', snippet: '\\sin', title: '\\sin' },
      { label: 'cos', snippet: '\\cos', title: '\\cos' },
      { label: 'tan', snippet: '\\tan', title: '\\tan' },
      { label: 'log', snippet: '\\log', title: '\\log' },
      { label: 'ln', snippet: '\\ln', title: '\\ln' },
      { label: 'exp', snippet: '\\exp', title: '\\exp' },
    ],
  },
];

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A beginner-friendly LaTeX math editor (inspired by the Lagrida equation
 * editor): a symbol toolbar that inserts snippets at the caret, a raw source
 * textarea, and a live KaTeX preview. The source is opaque to the parent — it
 * comes in via `initialSource` and is emitted back (debounced) via
 * `sourceChange`; `getSource()` lets the parent grab the latest value when
 * saving, bypassing the debounce.
 */
@Component({
  selector: 'app-latex-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './latex-editor.html',
  styleUrl: './latex-editor.scss',
  host: { '[class.latex-editor-focus]': 'focus()' },
})
export class LatexEditor implements AfterViewInit, OnDestroy {
  /** LaTeX source from the DB, read once when the editor mounts. */
  readonly initialSource = input<string>('');
  /** When true, source and preview sit side by side instead of stacked. */
  readonly focus = input<boolean>(false);
  /** Debounced source to persist; the parent saves the string verbatim. */
  readonly sourceChange = output<string>();

  protected readonly groups = TOOLBAR;

  // The symbol palette is tall; let the user collapse it (persisted) to give
  // the source + preview more room.
  protected readonly toolbarCollapsed = signal(
    localStorage.getItem('anubis_latex_toolbar_collapsed') === '1',
  );

  private textarea = viewChild<ElementRef<HTMLTextAreaElement>>('source');
  private preview = viewChild<ElementRef<HTMLDivElement>>('preview');

  protected readonly source = signal('');
  private readonly render = signal<KatexRenderToString | null>(null);
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Re-render the preview whenever the source changes or KaTeX finishes
    // loading. Writing innerHTML directly (not via an Angular binding) keeps
    // KaTeX's inline styles intact — the HTML sanitizer would strip them.
    effect(() => {
      const src = this.source();
      const render = this.render();
      const host = this.preview()?.nativeElement;
      if (!host || !render) return;
      this.renderPreview(host, src, render);
    });
  }

  async ngAfterViewInit(): Promise<void> {
    ensureKatexCss();
    const ta = this.textarea()?.nativeElement;
    if (ta) {
      ta.value = this.initialSource();
      this.source.set(ta.value);
    }
    const katex = (await import('katex')).default;
    this.render.set(katex.renderToString);
  }

  ngOnDestroy(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }

  /** Latest source, read straight from the live textarea. */
  getSource(): string {
    return this.textarea()?.nativeElement.value ?? this.source();
  }

  protected toggleToolbar(): void {
    const next = !this.toolbarCollapsed();
    this.toolbarCollapsed.set(next);
    localStorage.setItem('anubis_latex_toolbar_collapsed', next ? '1' : '0');
  }

  protected onInput(): void {
    const ta = this.textarea()?.nativeElement;
    if (!ta) return;
    this.source.set(ta.value);
    this.scheduleEmit();
  }

  protected insert(item: LatexToolbarItem): void {
    const ta = this.textarea()?.nativeElement;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    const braceIdx = item.snippet.indexOf('{}');

    let text: string;
    let caret: number;
    if (selected && braceIdx !== -1) {
      // Wrap the current selection inside the first empty braces.
      text = item.snippet.slice(0, braceIdx + 1) + selected + item.snippet.slice(braceIdx + 1);
      caret = braceIdx + 1 + selected.length + 1;
    } else {
      text = item.snippet;
      caret = item.caret ?? (braceIdx !== -1 ? braceIdx + 1 : item.snippet.length);
    }

    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + caret;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    this.source.set(ta.value);
    this.scheduleEmit();
  }

  private renderPreview(host: HTMLElement, src: string, render: KatexRenderToString): void {
    // Each blank-line-separated chunk renders as its own display equation, so a
    // notebook reads like a worksheet with several steps.
    const blocks = src
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    if (!blocks.length) {
      host.innerHTML = '<p class="latex-preview-empty">A pré-visualização aparece aqui.</p>';
      return;
    }
    host.innerHTML = blocks
      .map((block) => {
        try {
          const html = render(block, { displayMode: true, throwOnError: false });
          return `<div class="latex-block">${html}</div>`;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Erro ao renderizar LaTeX';
          return `<div class="latex-block latex-block-error">${escapeHtml(message)}</div>`;
        }
      })
      .join('');
  }

  private scheduleEmit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.sourceChange.emit(this.getSource());
    }, EMIT_DEBOUNCE_MS);
  }
}
