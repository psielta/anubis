import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
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
import { Book } from '../../core/models/book.model';
import { StudyKind, StudyMessage, StudyRequest } from '../../core/models/study.model';
import { Diagram, DiagramType } from '../../core/models/diagram.model';
import { ExcalidrawCanvas } from './excalidraw-canvas/excalidraw-canvas';
import { MermaidPreview } from './mermaid-preview/mermaid-preview';

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
  ],
  templateUrl: './reader.html',
  styleUrl: './reader.scss',
})
export class Reader implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private library = inject(LibraryService);
  private study = inject(StudyService);
  private diagrams = inject(DiagramsService);

  private viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private excalidrawCanvas = viewChild(ExcalidrawCanvas);

  protected readonly book = signal<Book | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly pageCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly zoomPct = signal(100);
  protected readonly toc = signal<TocItem[]>([]);

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
      void this.loadOutline();

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
    if (!this.pdfDoc) return;
    try {
      const raw = await this.pdfDoc.getOutline();
      if (!raw?.length) return;
      const items: TocItem[] = [];
      const walk = async (nodes: typeof raw, depth: number): Promise<void> => {
        for (const node of nodes) {
          items.push({ title: node.title, page: await this.destToPage(node.dest), depth });
          if (node.items?.length && depth < 2) await walk(node.items, depth + 1);
        }
      };
      await walk(raw, 0);
      this.toc.set(items);
    } catch {
      // The outline is optional — ignore any failure to read it.
    }
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
  togglePanel() {
    const open = !this.panelOpen();
    this.panelOpen.set(open);
    if (open) {
      this.diagramsOpen.set(false); // the two right-docked panels are exclusive
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

  // --- Study diagrams ------------------------------------------------------
  toggleDiagrams() {
    const open = !this.diagramsOpen();
    this.diagramsOpen.set(open);
    if (open) {
      this.panelOpen.set(false); // mutually exclusive with the AI panel
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
        this.diagramList.update((list) => [
          saved,
          ...list.filter((d) => d.id !== saved.id),
        ]);
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
      error: (err) =>
        this.diagramsError.set(err?.error?.detail ?? 'Could not delete diagram'),
    });
  }
}
