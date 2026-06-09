import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { Editor, JSONContent } from '@tiptap/core';
// Type-only: pulls in the @tiptap/core module augmentation (contentType,
// getMarkdown) without bundling the runtime, which is imported lazily below.
import type {} from '@tiptap/markdown';

// onUpdate fires on every keystroke; persist on a pause instead.
const EMIT_DEBOUNCE_MS = 600;

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  h1: boolean;
  h2: boolean;
  h3: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
  link: boolean;
}

const EMPTY_STATE: ToolbarState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  h1: false,
  h2: false,
  h3: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  codeBlock: false,
  link: false,
};

// A whole paragraph that is just `$$…$$` — used to rehydrate block equations on
// load, since the official migration only converts inline `$…$` strings.
const BLOCK_MATH_LINE = /^\$\$([\s\S]+)\$\$$/;

// KaTeX's stylesheet is served as a static asset and pulled in only when the
// editor first mounts, so it stays out of the initial bundle.
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

@Component({
  selector: 'app-note-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  templateUrl: './note-editor.html',
  styleUrl: './note-editor.scss',
})
export class NoteEditor implements AfterViewInit, OnDestroy {
  /** Initial Markdown source from the DB (read once, when the editor mounts). */
  readonly initialMarkdown = input<string>('');
  /** Debounced Markdown to persist; the parent saves the string verbatim. */
  readonly markdownChange = output<string>();

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  protected readonly ready = signal(false);
  protected readonly state = signal<ToolbarState>(EMPTY_STATE);

  private editor: Editor | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  async ngAfterViewInit(): Promise<void> {
    ensureKatexCss();
    const [{ Editor }, { default: StarterKit }, { Markdown }, math] = await Promise.all([
      import('@tiptap/core'),
      import('@tiptap/starter-kit'),
      import('@tiptap/markdown'),
      import('@tiptap/extension-mathematics'),
    ]);
    // The view may have been torn down while the chunks loaded.
    const element = this.host()?.nativeElement;
    if (!element) return;

    const katexOptions = { throwOnError: false };
    // Notes persist as Markdown, so teach the math nodes to serialize back to
    // `$…$` / `$$…$$`; the bundled nodes have no Markdown mapping of their own.
    const InlineMath = math.InlineMath.extend({
      renderMarkdown: (node: JSONContent) => wrapLatex(node, '$'),
    }).configure({ katexOptions, onClick: (n, pos) => this.editInlineMath(n, pos) });
    const BlockMath = math.BlockMath.extend({
      renderMarkdown: (node: JSONContent) => wrapLatex(node, '$$'),
    }).configure({ katexOptions, onClick: (n, pos) => this.editBlockMath(n, pos) });

    this.editor = new Editor({
      element,
      extensions: [StarterKit, Markdown, InlineMath, BlockMath],
      content: this.initialMarkdown(),
      contentType: 'markdown',
      onUpdate: () => {
        this.syncState();
        this.scheduleEmit();
      },
      onSelectionUpdate: () => this.syncState(),
    });
    this.hydrateMath(math.migrateMathStrings);
    this.syncState();
    this.ready.set(true);
  }

  ngOnDestroy(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.editor?.destroy();
    this.editor = null;
  }

  /** Latest content as Markdown, read straight from the live editor. */
  getMarkdown(): string | null {
    return this.editor ? this.editor.getMarkdown() : null;
  }

  // --- Toolbar commands ------------------------------------------------------
  toggleBold(): void {
    this.editor?.chain().focus().toggleBold().run();
  }
  toggleItalic(): void {
    this.editor?.chain().focus().toggleItalic().run();
  }
  toggleStrike(): void {
    this.editor?.chain().focus().toggleStrike().run();
  }
  toggleCode(): void {
    this.editor?.chain().focus().toggleCode().run();
  }
  toggleHeading(level: 1 | 2 | 3): void {
    this.editor?.chain().focus().toggleHeading({ level }).run();
  }
  toggleBulletList(): void {
    this.editor?.chain().focus().toggleBulletList().run();
  }
  toggleOrderedList(): void {
    this.editor?.chain().focus().toggleOrderedList().run();
  }
  toggleBlockquote(): void {
    this.editor?.chain().focus().toggleBlockquote().run();
  }
  toggleCodeBlock(): void {
    this.editor?.chain().focus().toggleCodeBlock().run();
  }
  setHorizontalRule(): void {
    this.editor?.chain().focus().setHorizontalRule().run();
  }
  undo(): void {
    this.editor?.chain().focus().undo().run();
  }
  redo(): void {
    this.editor?.chain().focus().redo().run();
  }

  toggleLink(): void {
    const editor = this.editor;
    if (!editor) return;
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt('Link URL')?.trim();
    if (url) editor.chain().focus().setLink({ href: url }).run();
  }

  insertInlineMath(): void {
    const latex = window.prompt('LaTeX (inline), e.g. E = mc^2')?.trim();
    if (latex) this.editor?.chain().focus().insertInlineMath({ latex }).run();
  }

  insertBlockMath(): void {
    const latex = window.prompt('LaTeX (block), e.g. \\int_0^1 x^2 dx')?.trim();
    if (latex) this.editor?.chain().focus().insertBlockMath({ latex }).run();
  }

  private editInlineMath(node: { attrs: { latex?: string } }, pos: number): void {
    const latex = window.prompt('Edit equation', node.attrs.latex ?? '')?.trim();
    if (latex != null) this.editor?.chain().focus().updateInlineMath({ latex, pos }).run();
  }

  private editBlockMath(node: { attrs: { latex?: string } }, pos: number): void {
    const latex = window.prompt('Edit equation', node.attrs.latex ?? '')?.trim();
    if (latex != null) this.editor?.chain().focus().updateBlockMath({ latex, pos }).run();
  }

  /** Convert Markdown math text (loaded as plain text) into live math nodes. */
  private hydrateMath(migrateInline: (editor: Editor) => void): void {
    const editor = this.editor;
    if (!editor) return;
    this.hydrateBlockMath(editor);
    migrateInline(editor); // official inline `$…$` migration
  }

  private hydrateBlockMath(editor: Editor): void {
    const blockType = editor.schema.nodes['blockMath'];
    if (!blockType) return;
    const hits: { from: number; to: number; latex: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return false;
      const match = BLOCK_MATH_LINE.exec(node.textContent.trim());
      if (match) hits.push({ from: pos, to: pos + node.nodeSize, latex: match[1].trim() });
      return false; // never descend into a paragraph's inline content
    });
    if (!hits.length) return;
    let tr = editor.state.tr;
    // Apply last-to-first so earlier positions stay valid as we splice.
    for (const hit of hits.reverse()) {
      tr = tr.replaceWith(
        tr.mapping.map(hit.from),
        tr.mapping.map(hit.to),
        blockType.create({ latex: hit.latex }),
      );
    }
    editor.view.dispatch(tr.setMeta('addToHistory', false));
  }

  private syncState(): void {
    const e = this.editor;
    if (!e) return;
    this.state.set({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
    });
  }

  private scheduleEmit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const md = this.getMarkdown();
      if (md != null) this.markdownChange.emit(md);
    }, EMIT_DEBOUNCE_MS);
  }
}

/** Serialize a math node's LaTeX wrapped in the given delimiter, or "" if empty. */
function wrapLatex(node: JSONContent, delimiter: string): string {
  const latex = String(node['attrs']?.['latex'] ?? '').trim();
  return latex ? `${delimiter}${latex}${delimiter}` : '';
}
