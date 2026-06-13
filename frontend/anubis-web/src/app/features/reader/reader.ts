import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MarkdownComponent } from 'ngx-markdown';
import * as pdfjsLib from 'pdfjs-dist';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  PageViewport,
} from 'pdfjs-dist';
import { LibraryService } from '../../core/services/library';
import { StudyService } from '../../core/services/study';
import { DiagramsService } from '../../core/services/diagrams';
import { NotesService } from '../../core/services/notes';
import { TocService } from '../../core/services/toc';
import { Book } from '../../core/models/book.model';
import { StudyKind, StudyMessage, StudyRequest } from '../../core/models/study.model';
import { Diagram, DiagramType } from '../../core/models/diagram.model';
import { Note } from '../../core/models/note.model';
import { ExcalidrawCanvas } from './excalidraw-canvas/excalidraw-canvas';
import { MermaidPreview } from './mermaid-preview/mermaid-preview';
import { NoteEditor } from './note-editor/note-editor';
import { ReaderPrefsService } from '../../core/services/reader-prefs';
import { PanelResizerDirective } from './panel-resizer.directive';

// Served as a static asset (see angular.json); must be an absolute URL so
// production nginx does not fall through to the SPA index.html.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface PdfPage {
  num: number;
  canvas: HTMLCanvasElement;
  rendered: boolean;
}

interface TocItem {
  title: string;
  page: number | null;
  depth: number;
}

const SAVE_DEBOUNCE_MS = 1200;

@Component({
  selector: 'app-reader',
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MarkdownComponent,
    ExcalidrawCanvas,
    MermaidPreview,
    NoteEditor,
    PanelResizerDirective,
  ],
  templateUrl: './reader.html',
  styleUrl: './reader.scss',
})
export class Reader implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private library = inject(LibraryService);
  private study = inject(StudyService);
  private diagrams = inject(DiagramsService);
  private notes = inject(NotesService);
  private tocService = inject(TocService);
  private prefs = inject(ReaderPrefsService);

  protected readonly panelWidth = this.prefs.panelWidth;
  protected readonly resizablePanelOpen = computed(
    () => this.tocOpen() || this.notesOpen() || this.diagramsOpen(),
  );

  private viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private excalidrawCanvas = viewChild(ExcalidrawCanvas);
  private noteEditor = viewChild(NoteEditor);

  protected readonly book = signal<Book | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly pageCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly zoomPct = signal(100);
  protected readonly toc = signal<TocItem[]>([]);
  protected readonly tocOpen = signal(false);
  protected readonly tocCustom = signal(false);
  protected readonly tocDraft = signal<TocItem[]>([]);
  protected readonly tocSaving = signal(false);
  protected readonly tocError = signal<string | null>(null);
  protected readonly tocHasBlankTitle = computed(() =>
    this.tocDraft().some((t) => !t.title.trim()),
  );

  // AI study assistant
  protected readonly panelOpen = signal(false);
  protected readonly aiScope = signal<'book' | 'chapter'>('book');
  protected readonly messages = signal<StudyMessage[]>([]);
  protected readonly thinking = signal('');
  protected readonly streamingAnswer = signal('');
  protected readonly pendingQuestion = signal<string | null>(null);
  protected readonly aiBusy = signal(false);
  protected readonly aiError = signal<string | null>(null);
  protected readonly selectionText = signal('');
  protected readonly selButtonTop = signal(0);
  protected readonly selButtonLeft = signal(0);
  protected readonly pendingSelection = signal<string | null>(null);
  private historyLoaded = false;
  private aiController: AbortController | null = null;

  // Study diagrams
  protected readonly diagramsOpen = signal(false);
  protected readonly diagramView = signal<'list' | 'edit'>('list');
  protected readonly diagramList = signal<Diagram[]>([]);
  protected readonly diagramsLoaded = signal(false);
  protected readonly diagramsError = signal<string | null>(null);
  protected readonly activeDiagram = signal<Diagram | null>(null);
  protected readonly draftTitle = signal('');
  protected readonly draftType = signal<DiagramType>('mermaid');
  protected readonly draftContent = signal(''); // mermaid source OR excalidraw scene JSON
  protected readonly draftPage = signal<number | null>(null);
  protected readonly diagramSaving = signal(false);

  // Study notes (Markdown)
  protected readonly notesOpen = signal(false);
  protected readonly noteView = signal<'list' | 'edit'>('list');
  protected readonly noteList = signal<Note[]>([]);
  protected readonly notesLoaded = signal(false);
  protected readonly notesError = signal<string | null>(null);
  protected readonly noteSearch = signal('');
  protected readonly activeNote = signal<Note | null>(null);
  protected readonly noteTitle = signal('');
  protected readonly noteContent = signal('');
  protected readonly notePage = signal<number | null>(null);
  protected readonly noteSaving = signal(false);
  protected readonly filteredNotes = computed(() => {
    const q = this.noteSearch().trim().toLowerCase();
    const list = this.noteList();
    if (!q) return list;
    return list.filter(
      (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q),
    );
  });

  private bookId = 0;
  private data: ArrayBuffer | null = null;
  private initialized = false;

  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pdfDoc: PDFDocumentProxy | null = null;
  private scaleBase = 1; // page scale that renders at 100%
  private observer: IntersectionObserver | null = null;
  private pages: PdfPage[] = [];
  private visible = new Set<number>();

  // Reading progress
  private resumePage: number | null = null;
  private resumed = false;
  private canSave = false;
  private lastSavedPage = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    this.bookId = Number(this.route.snapshot.paramMap.get('id'));
    if (!this.bookId) {
      this.fail('Invalid book');
      return;
    }
    this.library.get(this.bookId).subscribe({
      next: (book) => {
        this.book.set(book);
        if (book.file_format !== 'pdf') {
          this.fail('This book format cannot be read in the app');
          return;
        }
        this.resumePage = book.last_page && book.last_page > 1 ? book.last_page : null;
        this.lastSavedPage = book.last_page ?? 0;
        this.loadFile(this.bookId);
      },
      error: () => this.fail('Book not found'),
    });
  }

  ngAfterViewInit() {
    this.tryInit();
  }

  ngOnDestroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flushProgress();
    this.aiController?.abort();
    this.observer?.disconnect();
    this.loadingTask?.destroy();
  }

  private fail(message: string) {
    this.error.set(message);
    this.loading.set(false);
  }

  private loadFile(id: number) {
    this.library.download(id).subscribe({
      next: async (blob) => {
        this.data = await blob.arrayBuffer();
        this.loading.set(false);
        this.tryInit();
      },
      error: () => this.fail('Could not open this book'),
    });
  }

  private tryInit() {
    if (this.initialized) return;
    const el = this.viewport()?.nativeElement;
    if (!el || !this.data) return;
    this.initialized = true;
    void this.initPdf(el, this.data);
  }

  private async initPdf(el: HTMLElement, data: ArrayBuffer) {
    try {
      this.loadingTask = pdfjsLib.getDocument({ data });
      this.pdfDoc = await this.loadingTask.promise;
      this.pageCount.set(this.pdfDoc.numPages);

      const first = await this.pdfDoc.getPage(1);
      const unscaled = first.getViewport({ scale: 1 });
      const target = el.clientWidth - 48;
      this.scaleBase = target > 0 ? target / unscaled.width : 1;

      await this.buildPages(el);
      const saved = this.book()?.toc;
      if (saved?.length) {
        this.toc.set(this.cloneToc(saved));
        this.tocCustom.set(true);
      } else {
        this.tocCustom.set(false);
        void this.loadOutline();
      }

      if (!this.resumed) {
        this.resumed = true;
        const target = this.resumePage;
        if (target) {
          // Defer past layout so the viewport has its scrollable height.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              this.scrollToPage(el, target);
              this.canSave = true;
            }),
          );
        } else {
          this.canSave = true;
        }
      }
    } catch {
      this.error.set('Could not render this PDF');
    }
  }

  private async buildPages(el: HTMLElement) {
    if (!this.pdfDoc) return;
    this.observer?.disconnect();
    this.visible.clear();
    el.replaceChildren();
    this.pages = [];

    const scale = this.scaleBase * (this.zoomPct() / 100);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const num = Number((entry.target as HTMLElement).dataset['page']);
          if (entry.isIntersecting) {
            this.visible.add(num);
            void this.renderPage(num, scale);
          } else {
            this.visible.delete(num);
          }
        }
        if (this.visible.size) {
          this.currentPage.set(Math.min(...this.visible));
          this.scheduleSave();
        }
      },
      { root: el, rootMargin: '300px 0px', threshold: 0.01 },
    );

    for (let num = 1; num <= this.pdfDoc.numPages; num++) {
      const page = await this.pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.dataset['page'] = String(num);
      wrap.style.width = `${Math.floor(viewport.width)}px`;
      wrap.style.height = `${Math.floor(viewport.height)}px`;
      const canvas = document.createElement('canvas');
      wrap.appendChild(canvas);
      el.appendChild(wrap);
      this.pages.push({ num, canvas, rendered: false });
      this.observer.observe(wrap);
    }
  }

  private scrollToPage(el: HTMLElement, num: number) {
    const wrap = el.querySelector<HTMLElement>(`.pdf-page[data-page="${num}"]`);
    if (wrap) el.scrollTop = Math.max(0, wrap.offsetTop - 12);
  }

  goToPage(page: number) {
    const el = this.viewport()?.nativeElement;
    if (el) this.scrollToPage(el, page);
  }

  /** Build the table of contents from the PDF's outline (bookmarks), if any. */
  private async loadOutline() {
    this.toc.set(await this.extractOutline());
  }

  private async extractOutline(): Promise<TocItem[]> {
    if (!this.pdfDoc) return [];
    try {
      const raw = await this.pdfDoc.getOutline();
      if (!raw?.length) return [];
      const items: TocItem[] = [];
      const walk = async (nodes: typeof raw, depth: number): Promise<void> => {
        for (const node of nodes) {
          items.push({ title: node.title, page: await this.destToPage(node.dest), depth });
          if (node.items?.length && depth < 2) await walk(node.items, depth + 1);
        }
      };
      await walk(raw, 0);
      return items;
    } catch {
      return [];
    }
  }

  private cloneToc(items: TocItem[]): TocItem[] {
    return items.map((item) => ({ title: item.title, page: item.page, depth: item.depth }));
  }

  private async destToPage(dest: unknown): Promise<number | null> {
    if (!this.pdfDoc || !dest) return null;
    try {
      const explicit =
        typeof dest === 'string' ? await this.pdfDoc.getDestination(dest) : (dest as unknown[]);
      const ref = Array.isArray(explicit) ? explicit[0] : null;
      if (!ref) return null;
      const index = await this.pdfDoc.getPageIndex(
        ref as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
      return index + 1;
    } catch {
      return null;
    }
  }

  private async renderPage(num: number, scale: number) {
    const entry = this.pages.find((p) => p.num === num);
    if (!entry || entry.rendered || !this.pdfDoc) return;
    entry.rendered = true;

    const page = await this.pdfDoc.getPage(num);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });
    const hi = page.getViewport({ scale: scale * dpr });
    const canvas = entry.canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = Math.floor(hi.width);
    canvas.height = Math.floor(hi.height);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    try {
      await page.render({ canvas, canvasContext: ctx, viewport: hi }).promise;
      await this.renderTextLayer(page, canvas, viewport);
    } catch {
      entry.rendered = false;
    }
  }

  /** Transparent, selectable text layer over the page canvas (enables selection). */
  private async renderTextLayer(
    page: PDFPageProxy,
    canvas: HTMLCanvasElement,
    viewport: PageViewport,
  ) {
    const wrap = canvas.parentElement;
    if (!wrap || wrap.querySelector('.textLayer')) return;
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    pdfjsLib.setLayerDimensions(layer, viewport);
    layer.style.setProperty('--scale-factor', String(viewport.scale));
    wrap.appendChild(layer);
    try {
      await new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport,
      }).render();
    } catch {
      layer.remove();
    }
  }

  zoom(delta: number) {
    const next = Math.max(50, Math.min(300, this.zoomPct() + delta));
    if (next === this.zoomPct()) return;
    this.zoomPct.set(next);
    const el = this.viewport()?.nativeElement;
    if (!el) return;
    const keep = this.currentPage();
    void this.buildPages(el).then(() => this.scrollToPage(el, keep));
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushProgress();
    }, SAVE_DEBOUNCE_MS);
  }

  private flushProgress() {
    const page = this.currentPage();
    const total = this.pageCount();
    if (!this.canSave || !this.bookId || !total || page === this.lastSavedPage) return;
    this.lastSavedPage = page;
    this.library.saveProgress(this.bookId, page, total).subscribe({ error: () => {} });
  }

  // --- AI study assistant --------------------------------------------------
  protected onPanelResize(width: number) {
    this.prefs.setPanelWidth(width);
  }

  togglePanel() {
    const open = !this.panelOpen();
    this.panelOpen.set(open);
    if (open) {
      // The right-docked panels are mutually exclusive.
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.tocOpen.set(false);
      if (!this.historyLoaded) this.loadHistory();
    }
  }

  captureSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!text || !selection || selection.rangeCount === 0) {
      this.selectionText.set('');
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) {
      this.selectionText.set('');
      return;
    }
    this.selectionText.set(text);
    this.selButtonTop.set(Math.max(8, rect.bottom + 6));
    this.selButtonLeft.set(Math.max(8, Math.min(rect.left, window.innerWidth - 190)));
  }

  hideSelectionButton() {
    if (this.selectionText()) this.selectionText.set('');
  }

  askSelection() {
    const text = this.selectionText();
    if (!text) return;
    this.pendingSelection.set(text);
    this.selectionText.set('');
    window.getSelection()?.removeAllRanges();
    if (!this.panelOpen()) {
      this.panelOpen.set(true);
      if (!this.historyLoaded) this.loadHistory();
    }
  }

  clearPendingSelection() {
    this.pendingSelection.set(null);
  }

  private loadHistory() {
    this.study.history(this.bookId).subscribe({
      next: (messages) => {
        this.messages.set(messages);
        this.historyLoaded = true;
      },
      error: () => {},
    });
  }

  /** Page span of the current chapter, derived from the PDF outline. */
  chapterRange(): { from: number; to: number } | null {
    const entries = this.toc().filter((t) => t.page != null);
    if (!entries.length) return null;
    const page = this.currentPage();
    let from = entries[0].page as number;
    for (const e of entries) {
      const p = e.page as number;
      if (p <= page && p >= from) from = p;
    }
    const later = entries
      .map((e) => e.page as number)
      .filter((p) => p > from)
      .sort((a, b) => a - b);
    const to = later.length ? later[0] - 1 : this.pageCount();
    return { from, to: Math.max(from, to) };
  }

  send(kind: StudyKind, input?: HTMLInputElement) {
    if (this.aiBusy()) return;
    const selection = kind === 'chat' ? this.pendingSelection() : null;
    let question: string | undefined;
    if (kind === 'chat') {
      question = input?.value.trim() || undefined;
      if (!question && !selection) return;
    }

    const body: StudyRequest = { kind, scope: this.aiScope() };
    if (selection) {
      body.selection = selection;
      // Ground a selection in its surrounding chapter when the TOC allows it.
      const range = this.chapterRange();
      if (range) {
        body.scope = 'chapter';
        body.page_from = range.from;
        body.page_to = range.to;
      }
    } else if (body.scope === 'chapter') {
      const range = this.chapterRange();
      if (range) {
        body.page_from = range.from;
        body.page_to = range.to;
      } else {
        body.scope = 'book';
      }
    }
    if (question) body.question = question;

    let display: string | null = null;
    if (kind === 'chat') {
      const quote = selection
        ? `“${selection.slice(0, 120)}${selection.length > 120 ? '…' : ''}” `
        : '';
      display = (quote + (question ?? '')).trim() || null;
    }

    this.aiError.set(null);
    this.thinking.set('');
    this.streamingAnswer.set('');
    this.pendingQuestion.set(display);
    this.pendingSelection.set(null);
    this.aiBusy.set(true);
    if (input) input.value = '';

    this.aiController?.abort();
    this.aiController = new AbortController();

    void this.study.ask(
      this.bookId,
      body,
      {
        onThinking: (t) => this.thinking.update((v) => v + t),
        onDelta: (t) => this.streamingAnswer.update((v) => v + t),
        onDone: () => {
          this.study.history(this.bookId).subscribe({
            next: (messages) => {
              this.messages.set(messages);
              this.streamingAnswer.set('');
              this.thinking.set('');
              this.pendingQuestion.set(null);
              this.aiBusy.set(false);
            },
            error: () => this.aiBusy.set(false),
          });
        },
        onError: (message) => {
          this.aiError.set(message);
          this.aiBusy.set(false);
          this.pendingQuestion.set(null);
        },
      },
      this.aiController.signal,
    );
  }

  clearHistory() {
    this.study.clear(this.bookId).subscribe({
      next: () => this.messages.set([]),
      error: () => {},
    });
  }

  // --- Editable table of contents -----------------------------------------
  toggleToc() {
    const open = !this.tocOpen();
    this.tocOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.tocDraft.set(this.cloneToc(this.toc()));
      this.tocError.set(null);
    }
  }

  private blockEnd(list: TocItem[], index: number): number {
    const item = list[index];
    if (!item) return index;
    let end = index + 1;
    while (end < list.length && list[end].depth > item.depth) end++;
    return end;
  }

  private maxDepthInBlock(list: TocItem[], index: number): number {
    const end = this.blockEnd(list, index);
    return Math.max(...list.slice(index, end).map((item) => item.depth));
  }

  private canIndentIn(list: TocItem[], index: number): boolean {
    if (index <= 0 || index >= list.length) return false;
    const depth = list[index].depth;
    return depth <= list[index - 1].depth && this.maxDepthInBlock(list, index) < 2;
  }

  canIndent(index: number): boolean {
    return this.canIndentIn(this.tocDraft(), index);
  }

  private canOutdentIn(list: TocItem[], index: number): boolean {
    if (index < 0 || index >= list.length) return false;
    const depth = list[index].depth;
    if (depth <= 0) return false;
    const end = this.blockEnd(list, index);
    return end >= list.length || list[end].depth < depth;
  }

  canOutdent(index: number): boolean {
    return this.canOutdentIn(this.tocDraft(), index);
  }

  setTocTitle(index: number, value: string) {
    this.tocDraft.update((list) =>
      list.map((item, i) => (i === index ? { ...item, title: value } : item)),
    );
  }

  setTocPage(index: number, value: number) {
    const page = Number.isFinite(value) && value > 0 ? value : null;
    this.tocDraft.update((list) =>
      list.map((item, i) => (i === index ? { ...item, page } : item)),
    );
  }

  addTocEntry() {
    this.tocDraft.update((list) => [
      ...list,
      { title: 'New section', page: this.currentPage(), depth: 0 },
    ]);
    this.tocError.set(null);
  }

  indentTocEntry(index: number) {
    this.tocDraft.update((list) => {
      if (!this.canIndentIn(list, index)) return list;
      const end = this.blockEnd(list, index);
      return list.map((item, i) =>
        i >= index && i < end ? { ...item, depth: item.depth + 1 } : item,
      );
    });
  }

  outdentTocEntry(index: number) {
    this.tocDraft.update((list) => {
      if (!this.canOutdentIn(list, index)) return list;
      const end = this.blockEnd(list, index);
      return list.map((item, i) =>
        i >= index && i < end ? { ...item, depth: item.depth - 1 } : item,
      );
    });
  }

  deleteTocEntry(index: number) {
    this.tocDraft.update((list) => {
      const end = this.blockEnd(list, index);
      return [...list.slice(0, index), ...list.slice(end)];
    });
  }

  private previousSiblingStart(list: TocItem[], index: number): number | null {
    const depth = list[index]?.depth;
    if (depth == null) return null;
    for (let i = index - 1; i >= 0; i--) {
      if (list[i].depth < depth) return null;
      if (list[i].depth === depth) return i;
    }
    return null;
  }

  private nextSiblingStart(list: TocItem[], index: number): number | null {
    const depth = list[index]?.depth;
    if (depth == null) return null;
    const end = this.blockEnd(list, index);
    for (let i = end; i < list.length; i++) {
      if (list[i].depth < depth) return null;
      if (list[i].depth === depth) return i;
    }
    return null;
  }

  moveTocEntry(index: number, direction: -1 | 1) {
    this.tocDraft.update((list) => {
      if (index < 0 || index >= list.length) return list;
      const end = this.blockEnd(list, index);
      const block = list.slice(index, end);
      if (direction < 0) {
        const previous = this.previousSiblingStart(list, index);
        if (previous == null) return list;
        return [
          ...list.slice(0, previous),
          ...block,
          ...list.slice(previous, index),
          ...list.slice(end),
        ];
      }

      const next = this.nextSiblingStart(list, index);
      if (next == null) return list;
      const nextEnd = this.blockEnd(list, next);
      return [
        ...list.slice(0, index),
        ...list.slice(next, nextEnd),
        ...block,
        ...list.slice(nextEnd),
      ];
    });
  }

  async resetTocFromPdf() {
    this.tocDraft.set(this.cloneToc(await this.extractOutline()));
    this.tocError.set(null);
  }

  saveToc() {
    if (this.tocSaving() || this.tocHasBlankTitle()) return;
    const items = this.tocDraft().map((item) => ({
      title: item.title.trim(),
      page: item.page,
      depth: item.depth,
    }));

    this.tocSaving.set(true);
    this.tocError.set(null);
    this.tocService.save(this.bookId, items).subscribe({
      next: (book) => {
        void this.applySavedToc(book);
      },
      error: (err) => {
        this.tocError.set(err?.error?.detail ?? 'Could not save contents');
        this.tocSaving.set(false);
      },
    });
  }

  private async applySavedToc(book: Book) {
    this.book.set(book);
    const saved = book.toc?.length ? this.cloneToc(book.toc) : [];
    if (saved.length) {
      this.toc.set(saved);
      this.tocDraft.set(this.cloneToc(saved));
      this.tocCustom.set(true);
    } else {
      const outline = await this.extractOutline();
      this.toc.set(outline);
      this.tocDraft.set(this.cloneToc(outline));
      this.tocCustom.set(false);
    }
    this.tocSaving.set(false);
  }

  // --- Study diagrams ------------------------------------------------------
  toggleDiagrams() {
    const open = !this.diagramsOpen();
    this.diagramsOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.notesOpen.set(false);
      this.tocOpen.set(false);
      if (!this.diagramsLoaded()) this.loadDiagrams();
    }
  }

  private loadDiagrams() {
    this.diagrams.list(this.bookId).subscribe({
      next: (items) => {
        this.diagramList.set(items);
        this.diagramsLoaded.set(true);
      },
      error: () => this.diagramsError.set('Could not load diagrams'),
    });
  }

  newDiagram(type: DiagramType) {
    this.activeDiagram.set(null);
    this.draftType.set(type);
    this.draftTitle.set(type === 'mermaid' ? 'Untitled diagram' : 'Untitled drawing');
    this.draftContent.set(type === 'mermaid' ? 'graph TD\n  A[Start] --> B[End]' : '');
    this.draftPage.set(this.currentPage());
    this.diagramsError.set(null);
    this.diagramView.set('edit');
  }

  openDiagram(diagram: Diagram) {
    this.activeDiagram.set(diagram);
    this.draftType.set(diagram.type);
    this.draftTitle.set(diagram.title);
    this.draftContent.set(diagram.content);
    this.draftPage.set(diagram.page);
    this.diagramsError.set(null);
    this.diagramView.set('edit');
  }

  backToDiagramList() {
    this.diagramView.set('list');
  }

  setDraftPage(value: number) {
    this.draftPage.set(value && value > 0 ? value : null);
  }

  onSceneChange(json: string) {
    this.draftContent.set(json);
  }

  saveDiagram() {
    const title = this.draftTitle().trim();
    if (!title || this.diagramSaving()) return;

    // Excalidraw changes are debounced inside the canvas, so pull the freshest
    // scene synchronously before saving to avoid losing the last edits.
    let content = this.draftContent();
    if (this.draftType() === 'excalidraw') {
      const fresh = this.excalidrawCanvas()?.getScene();
      if (fresh != null) content = fresh;
    }

    this.diagramSaving.set(true);
    this.diagramsError.set(null);
    const existing = this.activeDiagram();
    const page = this.draftPage();
    const request = existing
      ? this.diagrams.update(this.bookId, existing.id, { title, content, page })
      : this.diagrams.create(this.bookId, {
          title,
          type: this.draftType(),
          content,
          page,
        });
    request.subscribe({
      next: (saved) => {
        this.activeDiagram.set(saved);
        this.draftContent.set(saved.content);
        this.diagramList.update((list) => [saved, ...list.filter((d) => d.id !== saved.id)]);
        this.diagramSaving.set(false);
      },
      error: (err) => {
        this.diagramsError.set(err?.error?.detail ?? 'Could not save diagram');
        this.diagramSaving.set(false);
      },
    });
  }

  deleteDiagram(diagram: Diagram) {
    this.diagrams.remove(this.bookId, diagram.id).subscribe({
      next: () => {
        this.diagramList.update((list) => list.filter((d) => d.id !== diagram.id));
        if (this.activeDiagram()?.id === diagram.id) {
          this.activeDiagram.set(null);
          this.diagramView.set('list');
        }
      },
      error: (err) => this.diagramsError.set(err?.error?.detail ?? 'Could not delete diagram'),
    });
  }

  // --- Study notes (Markdown) ----------------------------------------------
  toggleNotes() {
    const open = !this.notesOpen();
    this.notesOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.diagramsOpen.set(false);
      this.tocOpen.set(false);
      if (!this.notesLoaded()) this.loadNotes();
    }
  }

  private loadNotes() {
    this.notes.list(this.bookId).subscribe({
      next: (items) => {
        this.noteList.set(items);
        this.notesLoaded.set(true);
      },
      error: () => this.notesError.set('Could not load notes'),
    });
  }

  newNote() {
    this.activeNote.set(null);
    this.noteTitle.set('Untitled note');
    this.noteContent.set('');
    this.notePage.set(this.currentPage());
    this.notesError.set(null);
    this.noteView.set('edit');
  }

  openNote(note: Note) {
    this.activeNote.set(note);
    this.noteTitle.set(note.title);
    this.noteContent.set(note.content);
    this.notePage.set(note.page);
    this.notesError.set(null);
    this.noteView.set('edit');
  }

  onNoteContentChange(markdown: string) {
    this.noteContent.set(markdown);
  }

  backToNoteList() {
    this.noteView.set('list');
  }

  setNotePage(value: number) {
    this.notePage.set(value && value > 0 ? value : null);
  }

  /** Native date formatting — DatePipe would pull Angular's locale data into
   *  the initial bundle just for this label. */
  noteUpdatedLabel(note: Note): string {
    return new Date(note.updated_at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /** First content line, stripped of leading Markdown markers, for list cards. */
  noteExcerpt(note: Note): string {
    const line = note.content
      .split('\n')
      .map((l) => l.replace(/^[#>*\-+`\s]+|^\d+\.\s+/g, '').trim())
      .find((l) => l.length > 0);
    if (!line) return '';
    return line.length > 90 ? `${line.slice(0, 90)}…` : line;
  }

  saveNote() {
    const title = this.noteTitle().trim();
    if (!title || this.noteSaving()) return;

    // The editor debounces its markdownChange output, so pull the freshest
    // Markdown synchronously before saving to avoid losing the last edits.
    let content = this.noteContent();
    const fresh = this.noteEditor()?.getMarkdown();
    if (fresh != null) content = fresh;

    this.noteSaving.set(true);
    this.notesError.set(null);
    const existing = this.activeNote();
    const page = this.notePage();
    const request = existing
      ? this.notes.update(this.bookId, existing.id, { title, content, page })
      : this.notes.create(this.bookId, { title, content, page });
    request.subscribe({
      next: (saved) => {
        this.activeNote.set(saved);
        this.noteList.update((list) => [saved, ...list.filter((n) => n.id !== saved.id)]);
        this.noteSaving.set(false);
      },
      error: (err) => {
        this.notesError.set(err?.error?.detail ?? 'Could not save note');
        this.noteSaving.set(false);
      },
    });
  }

  deleteNote(note: Note) {
    this.notes.remove(this.bookId, note.id).subscribe({
      next: () => {
        this.noteList.update((list) => list.filter((n) => n.id !== note.id));
        if (this.activeNote()?.id === note.id) {
          this.activeNote.set(null);
          this.noteView.set('list');
        }
      },
      error: (err) => this.notesError.set(err?.error?.detail ?? 'Could not delete note'),
    });
  }
}
