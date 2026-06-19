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
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MarkdownComponent } from 'ngx-markdown';
import { forkJoin } from 'rxjs';
import * as pdfjsLib from 'pdfjs-dist';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from 'pdfjs-dist';
import { LibraryService } from '../../core/services/library';
import { StudyService } from '../../core/services/study';
import { DiagramsService } from '../../core/services/diagrams';
import { NotesService } from '../../core/services/notes';
import { SketchesService } from '../../core/services/sketches';
import { TocService } from '../../core/services/toc';
import { Book, ReaderPanel, ReaderState } from '../../core/models/book.model';
import { StudyKind, StudyMessage, StudyRequest } from '../../core/models/study.model';
import { Diagram, DiagramType } from '../../core/models/diagram.model';
import { Note } from '../../core/models/note.model';
import { Sketch, SketchGroup } from '../../core/models/sketch.model';
import { ExcalidrawCanvas } from './excalidraw-canvas/excalidraw-canvas';
import { MermaidPreview } from './mermaid-preview/mermaid-preview';
import { NoteEditor } from './note-editor/note-editor';
import { ReaderPrefsService } from '../../core/services/reader-prefs';
import { PanelResizerDirective } from './panel-resizer.directive';
import { NotificationsService } from '../../core/services/notifications';

// Served as a static asset (see angular.json); must be an absolute URL so
// production nginx does not fall through to the SPA index.html.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface PdfPage {
  num: number;
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  rendered: boolean;
  rendering: boolean;
  renderTask: RenderTask | null;
  generation: number;
}

interface TocItem {
  title: string;
  page: number | null;
  depth: number;
}

interface SketchSection {
  group: SketchGroup | null;
  sketches: Sketch[];
}

interface ReaderCommand {
  id: string;
  group: string;
  label: string;
  meta: string;
  page: number;
  depth: number;
  search: string;
}

interface ReaderCommandSection {
  title: string;
  items: ReaderCommand[];
}

const SAVE_DEBOUNCE_MS = 1200;
const READER_STATE_DEBOUNCE_MS = 800;
const SKETCH_AUTOSAVE_MS = 1500;

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
  private document = inject(DOCUMENT);
  private library = inject(LibraryService);
  private study = inject(StudyService);
  private diagrams = inject(DiagramsService);
  private notes = inject(NotesService);
  private sketches = inject(SketchesService);
  private tocService = inject(TocService);
  private prefs = inject(ReaderPrefsService);
  private notify = inject(NotificationsService);

  protected readonly panelWidth = this.prefs.panelWidth;
  protected readonly resizablePanelOpen = computed(
    () =>
      this.panelOpen() ||
      this.tocOpen() ||
      this.contentTreeOpen() ||
      this.notesOpen() ||
      this.diagramsOpen() ||
      (this.sketchesOpen() && !this.sketchFocus()),
  );

  private viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private commandPaletteInput = viewChild<ElementRef<HTMLInputElement>>('commandPaletteInput');
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
  protected readonly contentTreeOpen = signal(false);
  protected readonly contentTreeSaving = signal(false);
  protected readonly contentTreeError = signal<string | null>(null);
  protected readonly contentTreeMermaid = computed(() =>
    this.buildContentTreeMermaid(this.book()?.title ?? 'Book', this.toc()),
  );
  protected readonly commandPaletteOpen = signal(false);
  protected readonly commandPaletteQuery = signal('');
  protected readonly commandPaletteSelected = signal(0);
  protected readonly commandPaletteSections = computed<ReaderCommandSection[]>(() =>
    this.buildCommandPaletteSections(this.commandPaletteQuery(), this.toc(), this.pageCount()),
  );
  protected readonly commandPaletteCommands = computed<ReaderCommand[]>(() =>
    this.commandPaletteSections().flatMap((section) => section.items),
  );

  // AI study assistant
  protected readonly panelOpen = signal(false);
  protected readonly aiScope = signal<'book' | 'chapter'>('chapter');
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

  // Study sketches (Excalidraw notebook)
  protected readonly sketchesOpen = signal(false);
  protected readonly sketchView = signal<'list' | 'edit'>('list');
  protected readonly sketchList = signal<Sketch[]>([]);
  protected readonly sketchGroups = signal<SketchGroup[]>([]);
  protected readonly sketchesLoaded = signal(false);
  protected readonly sketchesError = signal<string | null>(null);
  protected readonly sketchSearch = signal('');
  protected readonly selectedSketchGroupId = signal<number | null>(null);
  protected readonly activeSketch = signal<Sketch | null>(null);
  protected readonly sketchTitle = signal('');
  protected readonly sketchContent = signal('');
  protected readonly sketchPage = signal<number | null>(null);
  protected readonly sketchGroupId = signal<number | null>(null);
  protected readonly sketchSaving = signal(false);
  protected readonly sketchSaveStatus = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  protected readonly sketchFocus = signal(false);
  protected readonly filteredSketches = computed(() => {
    const q = this.sketchSearch().trim().toLowerCase();
    const list = this.sketchList();
    if (!q) return list;
    return list.filter((s) => s.title.toLowerCase().includes(q));
  });
  protected readonly sketchSections = computed<SketchSection[]>(() => {
    const sketches = this.filteredSketches();
    const groups = this.sketchGroups();
    const sections: SketchSection[] = groups.map((group) => ({
      group,
      sketches: sketches.filter((s) => s.group_id === group.id),
    }));
    const ungrouped = sketches.filter((s) => s.group_id == null);
    if (ungrouped.length || !sections.length) {
      sections.push({ group: null, sketches: ungrouped });
    }
    return sections;
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
  private readerStateSaveEnabled = false;
  private readerStateTimer: ReturnType<typeof setTimeout> | null = null;
  private sketchAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private sketchSaveQueued = false;
  private sketchLastSaved:
    | { title: string; content: string; page: number | null; group_id: number | null }
    | null = null;
  private readonly commandPaletteKeydown = (event: KeyboardEvent) =>
    this.handleCommandPaletteKeydown(event);

  ngOnInit() {
    this.bookId = Number(this.route.snapshot.paramMap.get('id'));
    if (!this.bookId) {
      this.fail('Invalid book');
      return;
    }
    this.document.addEventListener('keydown', this.commandPaletteKeydown);
    this.library.get(this.bookId).subscribe({
      next: (book) => {
        this.book.set(book);
        if (book.file_format !== 'pdf') {
          this.fail('This book format cannot be read in the app');
          return;
        }
        this.resumePage = book.last_page && book.last_page > 1 ? book.last_page : null;
        this.lastSavedPage = book.last_page ?? 0;
        this.applySavedReaderState(book.reader_state);
        this.loadFile(this.bookId);
      },
      error: () => this.fail('Book not found'),
    });
  }

  ngAfterViewInit() {
    this.tryInit();
  }

  ngOnDestroy() {
    this.document.removeEventListener('keydown', this.commandPaletteKeydown);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flushProgress();
    this.flushSketchAutosave();
    if (this.readerStateTimer) clearTimeout(this.readerStateTimer);
    this.flushReaderState();
    this.aiController?.abort();
    this.observer?.disconnect();
    this.loadingTask?.destroy();
  }

  private fail(message: string) {
    this.error.set(message);
    this.loading.set(false);
  }

  private errorText(err: unknown, fallback: string): string {
    const detail = (err as { error?: { detail?: unknown } })?.error?.detail;
    return typeof detail === 'string' && detail.trim() ? detail : fallback;
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
        if (this.tocOpen()) this.tocDraft.set(this.cloneToc(saved));
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
    this.releaseAllPages();
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
            this.releasePage(num);
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
      this.pages.push({
        num,
        wrap,
        canvas,
        rendered: false,
        rendering: false,
        renderTask: null,
        generation: 0,
      });
      this.observer.observe(wrap);
    }
  }

  private releaseAllPages() {
    for (const entry of this.pages) {
      this.releasePageEntry(entry);
    }
  }

  private releasePage(num: number) {
    const entry = this.pages.find((p) => p.num === num);
    if (entry) this.releasePageEntry(entry);
  }

  private releasePageEntry(entry: PdfPage) {
    entry.generation += 1;
    try {
      entry.renderTask?.cancel();
    } catch {
      // A completed or already-cancelled pdf.js render task can ignore this.
    }
    entry.renderTask = null;
    entry.rendering = false;
    entry.rendered = false;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas.style.width = '';
    entry.canvas.style.height = '';
    entry.wrap.querySelector('.textLayer')?.remove();
  }

  private scrollToPage(el: HTMLElement, num: number) {
    const wrap = el.querySelector<HTMLElement>(`.pdf-page[data-page="${num}"]`);
    if (wrap) el.scrollTop = Math.max(0, wrap.offsetTop - 12);
  }

  goToPage(page: number) {
    const el = this.viewport()?.nativeElement;
    if (el) this.scrollToPage(el, page);
  }

  openCommandPalette() {
    if (this.loading() || this.error()) return;
    this.commandPaletteQuery.set('');
    this.commandPaletteSelected.set(0);
    this.commandPaletteOpen.set(true);
    requestAnimationFrame(() => this.commandPaletteInput()?.nativeElement.focus());
  }

  closeCommandPalette() {
    this.commandPaletteOpen.set(false);
  }

  setCommandPaletteQuery(value: string) {
    this.commandPaletteQuery.set(value);
    this.commandPaletteSelected.set(0);
  }

  onCommandPaletteInputKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveCommandPaletteSelection(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveCommandPaletteSelection(-1);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      this.runSelectedCommand();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeCommandPalette();
    }
  }

  selectCommandPaletteCommand(command: ReaderCommand) {
    const index = this.commandPaletteCommands().findIndex((item) => item.id === command.id);
    if (index >= 0) this.commandPaletteSelected.set(index);
  }

  isCommandPaletteSelected(command: ReaderCommand): boolean {
    return this.commandPaletteCommands()[this.commandPaletteSelected()]?.id === command.id;
  }

  runCommandPaletteCommand(command: ReaderCommand) {
    this.closeCommandPalette();
    this.goToPage(command.page);
  }

  private runSelectedCommand() {
    const command = this.commandPaletteCommands()[this.commandPaletteSelected()];
    if (command) this.runCommandPaletteCommand(command);
  }

  private moveCommandPaletteSelection(delta: -1 | 1) {
    const total = this.commandPaletteCommands().length;
    if (!total) {
      this.commandPaletteSelected.set(0);
      return;
    }
    const next = (this.commandPaletteSelected() + delta + total) % total;
    this.commandPaletteSelected.set(next);
  }

  private buildCommandPaletteSections(
    query: string,
    items: TocItem[],
    pageCount: number,
  ): ReaderCommandSection[] {
    const normalizedQuery = this.normalizeCommandQuery(query);
    const sections: ReaderCommandSection[] = [];
    const pageCommand = this.pageCommandForQuery(query, pageCount);
    if (pageCommand) {
      sections.push({ title: 'Pages', items: [pageCommand] });
    }

    const contents = items
      .filter((item): item is TocItem & { page: number } => item.page != null && item.page > 0)
      .map((item, index) => this.tocCommand(item, index))
      .filter((command) => !normalizedQuery || command.search.includes(normalizedQuery));

    if (contents.length) {
      sections.push({ title: 'Contents', items: contents });
    }

    return sections;
  }

  private tocCommand(item: TocItem & { page: number }, index: number): ReaderCommand {
    const title = item.title.trim() || 'Untitled section';
    const depth = Math.max(0, Math.min(item.depth, 4));
    const meta = `p. ${item.page}`;
    return {
      id: `toc-${index}-${item.page}`,
      group: 'Contents',
      label: title,
      meta,
      page: item.page,
      depth,
      search: this.normalizeCommandQuery(`${title} ${meta} ${item.page}`),
    };
  }

  private pageCommandForQuery(query: string, pageCount: number): ReaderCommand | null {
    const page = Number(query.trim());
    if (!Number.isInteger(page) || page < 1 || page > pageCount) return null;
    return {
      id: `page-${page}`,
      group: 'Pages',
      label: `Go to page ${page}`,
      meta: `${page} / ${pageCount}`,
      page,
      depth: 0,
      search: String(page),
    };
  }

  private normalizeCommandQuery(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  private handleCommandPaletteKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;

    if (event.key === 'Escape' && this.commandPaletteOpen()) {
      event.preventDefault();
      this.closeCommandPalette();
      return;
    }

    const key = event.key.toLowerCase();
    const isOpenShortcut =
      (event.ctrlKey || event.metaKey) && (key === 'k' || event.code === 'KeyK');
    if (!isOpenShortcut || this.shouldIgnoreCommandPaletteShortcut(event.target)) return;

    event.preventDefault();
    this.openCommandPalette();
  }

  private shouldIgnoreCommandPaletteShortcut(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const editable = target.closest(
      'input, textarea, select, [contenteditable="true"], app-note-editor, app-excalidraw-canvas',
    );
    if (editable) return true;
    return target instanceof HTMLElement && target.isContentEditable;
  }

  /** Build the table of contents from the PDF's outline (bookmarks), if any. */
  private async loadOutline() {
    const outline = await this.extractOutline();
    this.toc.set(outline);
    if (this.tocOpen()) this.tocDraft.set(this.cloneToc(outline));
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
    if (!entry || entry.rendered || entry.rendering || !this.pdfDoc) return;

    entry.rendering = true;
    const generation = ++entry.generation;

    try {
      const page = await this.pdfDoc.getPage(num);
      if (generation !== entry.generation || !this.visible.has(num)) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale });
      const hi = page.getViewport({ scale: scale * dpr });
      const canvas = entry.canvas;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = Math.floor(hi.width);
      canvas.height = Math.floor(hi.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const task = page.render({ canvas, canvasContext: ctx, viewport: hi });
      entry.renderTask = task;
      await task.promise;
      if (generation !== entry.generation || !this.visible.has(num)) return;
      await this.renderTextLayer(page, canvas, viewport);
      if (generation !== entry.generation || !this.visible.has(num)) return;
      entry.rendered = true;
    } catch {
      if (generation === entry.generation) entry.rendered = false;
    } finally {
      if (generation === entry.generation) {
        entry.renderTask = null;
        entry.rendering = false;
      }
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
    this.scheduleReaderStateSave();
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

  private applySavedReaderState(state: ReaderState | null) {
    if (!state) {
      this.readerStateSaveEnabled = true;
      return;
    }

    this.zoomPct.set(this.clampZoom(state.zoom_pct));
    this.prefs.setPanelWidth(state.panel_width_px);
    this.noteSearch.set(state.notes.search ?? '');
    this.sketchSearch.set(state.sketches?.search ?? '');

    this.panelOpen.set(false);
    this.diagramsOpen.set(false);
    this.notesOpen.set(false);
    this.sketchesOpen.set(false);
    this.tocOpen.set(false);
    this.contentTreeOpen.set(false);

    switch (state.panel) {
      case 'assistant':
        this.aiScope.set('chapter');
        this.panelOpen.set(true);
        if (!this.historyLoaded) this.loadHistory();
        break;
      case 'diagrams':
        this.diagramsOpen.set(true);
        this.restoreDiagramsState(state);
        break;
      case 'notes':
        this.notesOpen.set(true);
        this.restoreNotesState(state);
        break;
      case 'sketches':
        this.sketchesOpen.set(true);
        this.restoreSketchesState(state);
        break;
      case 'toc':
        this.tocOpen.set(true);
        this.tocDraft.set(this.cloneToc(this.toc()));
        break;
      case 'content_tree':
        this.contentTreeOpen.set(true);
        break;
    }

    this.readerStateSaveEnabled = true;
  }

  private clampZoom(value: number): number {
    return Math.max(50, Math.min(300, Math.round(value)));
  }

  private openPanelName(): ReaderPanel | null {
    if (this.panelOpen()) return 'assistant';
    if (this.diagramsOpen()) return 'diagrams';
    if (this.notesOpen()) return 'notes';
    if (this.sketchesOpen()) return 'sketches';
    if (this.tocOpen()) return 'toc';
    if (this.contentTreeOpen()) return 'content_tree';
    return null;
  }

  private buildReaderState(): ReaderState {
    const activeNote = this.activeNote();
    const activeDiagram = this.activeDiagram();
    const activeSketch = this.activeSketch();
    return {
      version: 1,
      zoom_pct: this.zoomPct(),
      panel: this.openPanelName(),
      panel_width_px: this.panelWidth(),
      notes: {
        view: activeNote && this.noteView() === 'edit' ? 'edit' : 'list',
        active_id: activeNote?.id ?? null,
        search: this.noteSearch(),
      },
      diagrams: {
        view: activeDiagram && this.diagramView() === 'edit' ? 'edit' : 'list',
        active_id: activeDiagram?.id ?? null,
      },
      sketches: {
        view: activeSketch && this.sketchView() === 'edit' ? 'edit' : 'list',
        active_id: activeSketch?.id ?? null,
        active_group_id: this.selectedSketchGroupId(),
        search: this.sketchSearch(),
      },
    };
  }

  private scheduleReaderStateSave() {
    if (!this.readerStateSaveEnabled || !this.bookId) return;
    if (this.readerStateTimer) clearTimeout(this.readerStateTimer);
    this.readerStateTimer = setTimeout(() => {
      this.readerStateTimer = null;
      this.flushReaderState();
    }, READER_STATE_DEBOUNCE_MS);
  }

  private flushReaderState() {
    if (!this.readerStateSaveEnabled || !this.bookId) return;
    this.library.saveReaderState(this.bookId, this.buildReaderState()).subscribe({
      error: () => {},
    });
  }

  // --- AI study assistant --------------------------------------------------
  protected onPanelResize(width: number) {
    this.prefs.setPanelWidth(width);
    this.scheduleReaderStateSave();
  }

  private closeSketchesPanel() {
    if (!this.sketchesOpen()) return;
    this.flushSketchAutosave();
    this.sketchFocus.set(false);
    this.sketchesOpen.set(false);
  }

  togglePanel() {
    const open = !this.panelOpen();
    this.panelOpen.set(open);
    if (open) {
      // The right-docked panels are mutually exclusive.
      this.aiScope.set('chapter');
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      if (!this.historyLoaded) this.loadHistory();
    }
    this.scheduleReaderStateSave();
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
      this.aiScope.set('chapter');
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      this.panelOpen.set(true);
      if (!this.historyLoaded) this.loadHistory();
      this.scheduleReaderStateSave();
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

  effectiveAiScope(): 'book' | 'chapter' {
    return this.aiScope() === 'chapter' && this.chapterRange() ? 'chapter' : 'book';
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
      } else if (body.scope === 'chapter') {
        body.scope = 'book';
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
          this.notify.error(message);
          this.aiBusy.set(false);
          this.pendingQuestion.set(null);
        },
      },
      this.aiController.signal,
    );
  }

  clearHistory() {
    this.study.clear(this.bookId).subscribe({
      next: () => {
        this.messages.set([]);
        this.notify.success('Study history cleared');
      },
      error: (err) => this.notify.error(this.errorText(err, 'Could not clear study history')),
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
      this.closeSketchesPanel();
      this.contentTreeOpen.set(false);
      this.tocDraft.set(this.cloneToc(this.toc()));
      this.tocError.set(null);
    }
    this.scheduleReaderStateSave();
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
        void this.applySavedToc(book).then(() => this.notify.success('Contents saved'));
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not save contents');
        this.tocError.set(message);
        this.notify.error(message);
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

  // --- Content tree ---------------------------------------------------------
  toggleContentTree() {
    const open = !this.contentTreeOpen();
    this.contentTreeOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.tocOpen.set(false);
      this.contentTreeError.set(null);
    }
    this.scheduleReaderStateSave();
  }

  private buildContentTreeMermaid(bookTitle: string, items: TocItem[]): string {
    const lines = [
      'flowchart TB',
      `  root["${this.wrappedMermaidLabel(bookTitle, 34)}"]`,
      '  classDef root fill:#15151d,color:#e8cf88,stroke:#c8a24c,stroke-width:1px;',
      '  classDef depth0 fill:#fbf6ea,color:#2a2520,stroke:#c8a24c,stroke-width:1px;',
      '  classDef depth1 fill:#efe5cd,color:#2a2520,stroke:#e0d2ab,stroke-width:1px;',
      '  classDef depth2 fill:#ffffff,color:#2a2520,stroke:#e0d2ab,stroke-width:1px;',
      '  class root root;',
    ];
    let previous = 'root';
    items.forEach((item, index) => {
      const depth = Math.max(0, Math.min(2, Math.round(item.depth)));
      const id = `toc_${index}`;
      const prefix = this.contentTreePrefix(depth);
      const title = item.page
        ? `${prefix}${item.title} (p. ${item.page})`
        : `${prefix}${item.title}`;
      lines.push(`  ${id}["${this.wrappedMermaidLabel(title, 42)}"]`);
      lines.push(`  ${previous} --> ${id}`);
      lines.push(`  class ${id} depth${depth};`);
      previous = id;
    });
    return lines.join('\n');
  }

  private contentTreePrefix(depth: number): string {
    if (depth === 1) return '|-- ';
    if (depth >= 2) return '|  |-- ';
    return '';
  }

  private wrappedMermaidLabel(value: string, maxLine = 42): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    const lines: string[] = [];
    let line = '';
    for (let word of normalized.split(' ')) {
      while (word.length > maxLine) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, maxLine));
        word = word.slice(maxLine);
      }
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (next.length <= maxLine) {
        line = next;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.map((part) => this.mermaidLabel(part)).join('<br/>');
  }

  private mermaidLabel(value: string): string {
    return value
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private contentTreeDiagramTitle(): string {
    const title = `${this.book()?.title?.trim() || 'Book'} content tree`;
    return title.length > 200 ? title.slice(0, 200) : title;
  }

  saveContentTreeDiagram() {
    const content = this.contentTreeMermaid();
    if (this.contentTreeSaving() || !this.toc().length || !content.trim()) return;

    this.contentTreeSaving.set(true);
    this.contentTreeError.set(null);
    this.diagrams
      .create(this.bookId, {
        title: this.contentTreeDiagramTitle(),
        type: 'mermaid',
        content,
        page: null,
      })
      .subscribe({
        next: (saved) => {
          if (this.diagramsLoaded()) {
            this.diagramList.update((list) => [saved, ...list.filter((d) => d.id !== saved.id)]);
          }
          this.contentTreeSaving.set(false);
          this.notify.success('Content tree saved as diagram');
        },
        error: (err) => {
          const message = this.errorText(err, 'Could not save content tree');
          this.contentTreeError.set(message);
          this.notify.error(message);
          this.contentTreeSaving.set(false);
        },
      });
  }

  // --- Study diagrams ------------------------------------------------------
  toggleDiagrams() {
    const open = !this.diagramsOpen();
    this.diagramsOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      if (!this.diagramsLoaded()) this.loadDiagrams();
    }
    this.scheduleReaderStateSave();
  }

  private loadDiagrams(afterLoad?: () => void) {
    this.diagrams.list(this.bookId).subscribe({
      next: (items) => {
        this.diagramList.set(items);
        this.diagramsLoaded.set(true);
        afterLoad?.();
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not load diagrams');
        this.diagramsError.set(message);
        this.notify.error(message);
      },
    });
  }

  private restoreDiagramsState(state: ReaderState) {
    const activeId = state.diagrams.view === 'edit' ? state.diagrams.active_id : null;
    this.loadDiagrams(() => {
      if (!this.diagramsOpen()) return;
      if (!activeId) {
        this.diagramView.set('list');
        return;
      }
      const diagram = this.diagramList().find((d) => d.id === activeId);
      if (diagram) {
        this.setActiveDiagram(diagram);
      } else {
        this.diagrams.get(this.bookId, activeId).subscribe({
          next: (item) => {
            if (!this.diagramsOpen()) return;
            this.diagramList.update((list) => [item, ...list.filter((d) => d.id !== item.id)]);
            this.setActiveDiagram(item);
          },
          error: () => this.diagramView.set('list'),
        });
      }
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
    this.scheduleReaderStateSave();
  }

  openDiagram(diagram: Diagram) {
    this.setActiveDiagram(diagram);
    this.scheduleReaderStateSave();
  }

  private setActiveDiagram(diagram: Diagram) {
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
    this.scheduleReaderStateSave();
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
        this.scheduleReaderStateSave();
        this.notify.success('Diagram saved');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not save diagram');
        this.diagramsError.set(message);
        this.notify.error(message);
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
        this.scheduleReaderStateSave();
        this.notify.success('Diagram deleted');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not delete diagram');
        this.diagramsError.set(message);
        this.notify.error(message);
      },
    });
  }

  // --- Study sketches (Excalidraw notebook) --------------------------------
  toggleSketches() {
    const open = !this.sketchesOpen();
    if (!open) {
      this.closeSketchesPanel();
      this.scheduleReaderStateSave();
      return;
    }

    this.sketchesOpen.set(true);
    this.panelOpen.set(false);
    this.diagramsOpen.set(false);
    this.notesOpen.set(false);
    this.tocOpen.set(false);
    this.contentTreeOpen.set(false);
    this.sketchesError.set(null);
    if (!this.sketchesLoaded()) this.loadSketches();
    this.scheduleReaderStateSave();
  }

  private loadSketches(afterLoad?: () => void) {
    forkJoin({
      groups: this.sketches.listGroups(this.bookId),
      sketches: this.sketches.list(this.bookId),
    }).subscribe({
      next: ({ groups, sketches }) => {
        this.sketchGroups.set(groups);
        this.sketchList.set(sketches);
        this.sketchesLoaded.set(true);
        afterLoad?.();
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not load sketches');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  private restoreSketchesState(state: ReaderState) {
    const sketchState = state.sketches;
    this.selectedSketchGroupId.set(sketchState?.active_group_id ?? null);
    const activeId = sketchState?.view === 'edit' ? sketchState.active_id : null;
    this.loadSketches(() => {
      if (!this.sketchesOpen()) return;
      if (!activeId) {
        this.sketchView.set('list');
        return;
      }
      const sketch = this.sketchList().find((s) => s.id === activeId);
      if (sketch) {
        this.setActiveSketch(sketch);
      } else {
        this.sketches.get(this.bookId, activeId).subscribe({
          next: (item) => {
            if (!this.sketchesOpen()) return;
            this.sketchList.update((list) => [item, ...list.filter((s) => s.id !== item.id)]);
            this.setActiveSketch(item);
          },
          error: () => this.sketchView.set('list'),
        });
      }
    });
  }

  createSketchGroup() {
    const name = window.prompt('Group name')?.trim();
    if (!name) return;
    this.sketches.createGroup(this.bookId, { name }).subscribe({
      next: (group) => {
        this.sketchGroups.update((groups) => [...groups, group]);
        this.selectedSketchGroupId.set(group.id);
        this.scheduleReaderStateSave();
        this.notify.success('Group created');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not create group');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  renameSketchGroup(group: SketchGroup) {
    const name = window.prompt('Group name', group.name)?.trim();
    if (!name || name === group.name) return;
    this.sketches.updateGroup(this.bookId, group.id, { name }).subscribe({
      next: (saved) => {
        this.sketchGroups.update((groups) =>
          groups.map((item) => (item.id === saved.id ? saved : item)),
        );
        this.notify.success('Group renamed');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not rename group');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  deleteSketchGroup(group: SketchGroup) {
    const ok = window.confirm(`Delete "${group.name}"? Sketches will move to Ungrouped.`);
    if (!ok) return;
    this.sketches.removeGroup(this.bookId, group.id).subscribe({
      next: () => {
        this.sketchGroups.update((groups) => groups.filter((item) => item.id !== group.id));
        this.sketchList.update((items) =>
          items.map((item) =>
            item.group_id === group.id ? { ...item, group_id: null } : item,
          ),
        );
        if (this.selectedSketchGroupId() === group.id) this.selectedSketchGroupId.set(null);
        if (this.sketchGroupId() === group.id) {
          this.sketchGroupId.set(null);
          this.scheduleSketchAutosave();
        }
        this.scheduleReaderStateSave();
        this.notify.success('Group deleted');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not delete group');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  newSketch(groupId?: number | null) {
    if (this.sketchSaving()) return;
    const targetGroupId = groupId === undefined ? this.selectedSketchGroupId() : groupId;
    this.flushSketchAutosave();
    this.sketchSaving.set(true);
    this.sketchSaveStatus.set('saving');
    this.sketchesError.set(null);
    this.sketches
      .create(this.bookId, {
        title: 'Untitled sketch',
        content: '',
        group_id: targetGroupId,
        page: this.currentPage(),
      })
      .subscribe({
        next: (saved) => {
          this.sketchSaving.set(false);
          this.sketchSaveStatus.set('saved');
          this.sketchList.update((list) => [saved, ...list.filter((s) => s.id !== saved.id)]);
          this.setActiveSketch(saved);
          this.scheduleReaderStateSave();
          this.notify.success('Sketch created');
        },
        error: (err) => {
          const message = this.errorText(err, 'Could not create sketch');
          this.sketchSaving.set(false);
          this.sketchSaveStatus.set('error');
          this.sketchesError.set(message);
          this.notify.error(message);
        },
      });
  }

  openSketch(sketch: Sketch) {
    if (this.activeSketch()?.id !== sketch.id) this.flushSketchAutosave();
    this.setActiveSketch(sketch);
    this.scheduleReaderStateSave();
  }

  private setActiveSketch(sketch: Sketch) {
    this.activeSketch.set(sketch);
    this.sketchTitle.set(sketch.title);
    this.sketchContent.set(sketch.content);
    this.sketchPage.set(sketch.page);
    this.sketchGroupId.set(sketch.group_id);
    this.selectedSketchGroupId.set(sketch.group_id);
    this.sketchLastSaved = {
      title: sketch.title,
      content: sketch.content,
      page: sketch.page,
      group_id: sketch.group_id,
    };
    this.sketchSaveStatus.set('saved');
    this.sketchesError.set(null);
    this.sketchView.set('edit');
  }

  backToSketchList() {
    this.flushSketchAutosave();
    this.sketchFocus.set(false);
    this.sketchView.set('list');
    this.scheduleReaderStateSave();
  }

  setSketchSearch(value: string) {
    this.sketchSearch.set(value);
    this.scheduleReaderStateSave();
  }

  selectSketchGroup(groupId: number | null) {
    this.selectedSketchGroupId.set(groupId);
    this.scheduleReaderStateSave();
  }

  setSketchTitle(value: string) {
    this.sketchTitle.set(value);
    this.scheduleSketchAutosave();
  }

  setSketchPage(value: number) {
    this.sketchPage.set(value && value > 0 ? value : null);
    this.scheduleSketchAutosave();
  }

  setSketchGroup(value: string) {
    const groupId = value ? Number(value) : null;
    this.sketchGroupId.set(groupId != null && Number.isFinite(groupId) ? groupId : null);
    this.selectedSketchGroupId.set(this.sketchGroupId());
    this.scheduleSketchAutosave();
    this.scheduleReaderStateSave();
  }

  onSketchSceneChange(json: string) {
    this.sketchContent.set(json);
    this.scheduleSketchAutosave();
  }

  toggleSketchFocus() {
    this.sketchFocus.update((value) => !value);
  }

  sketchUpdatedLabel(sketch: Sketch): string {
    return new Date(sketch.updated_at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  sketchGroupName(groupId: number | null): string {
    if (groupId == null) return 'Ungrouped';
    return this.sketchGroups().find((group) => group.id === groupId)?.name ?? 'Ungrouped';
  }

  deleteSketch(sketch: Sketch) {
    this.sketches.remove(this.bookId, sketch.id).subscribe({
      next: () => {
        this.sketchList.update((list) => list.filter((s) => s.id !== sketch.id));
        if (this.activeSketch()?.id === sketch.id) {
          this.activeSketch.set(null);
          this.sketchLastSaved = null;
          this.sketchFocus.set(false);
          this.sketchView.set('list');
          this.sketchSaveStatus.set('idle');
        }
        this.scheduleReaderStateSave();
        this.notify.success('Sketch deleted');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not delete sketch');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  private scheduleSketchAutosave() {
    if (!this.activeSketch()) return;
    this.sketchSaveStatus.set('idle');
    if (this.sketchAutoSaveTimer) clearTimeout(this.sketchAutoSaveTimer);
    this.sketchAutoSaveTimer = setTimeout(() => {
      this.sketchAutoSaveTimer = null;
      this.flushSketchAutosave();
    }, SKETCH_AUTOSAVE_MS);
  }

  private currentSketchPayload() {
    let content = this.sketchContent();
    if (this.sketchesOpen() && this.sketchView() === 'edit') {
      const fresh = this.excalidrawCanvas()?.getScene();
      if (fresh != null) content = fresh;
    }
    return {
      title: this.sketchTitle().trim(),
      content,
      page: this.sketchPage(),
      group_id: this.sketchGroupId(),
    };
  }

  private flushSketchAutosave() {
    if (this.sketchAutoSaveTimer) {
      clearTimeout(this.sketchAutoSaveTimer);
      this.sketchAutoSaveTimer = null;
    }
    const sketch = this.activeSketch();
    if (!sketch) return;
    if (this.sketchSaving()) {
      this.sketchSaveQueued = true;
      return;
    }

    const payload = this.currentSketchPayload();
    if (!payload.title) {
      this.sketchSaveStatus.set('error');
      this.sketchesError.set('Sketch title cannot be empty');
      return;
    }
    if (
      this.sketchLastSaved &&
      payload.title === this.sketchLastSaved.title &&
      payload.content === this.sketchLastSaved.content &&
      payload.page === this.sketchLastSaved.page &&
      payload.group_id === this.sketchLastSaved.group_id
    ) {
      this.sketchSaveStatus.set('saved');
      return;
    }

    this.sketchSaving.set(true);
    this.sketchSaveStatus.set('saving');
    this.sketchesError.set(null);
    this.sketches.update(this.bookId, sketch.id, payload).subscribe({
      next: (saved) => {
        const queued = this.sketchSaveQueued;
        const stillActive = this.activeSketch()?.id === saved.id;
        if (stillActive) {
          this.activeSketch.set(saved);
          if (!queued) this.sketchContent.set(saved.content);
        }
        this.sketchList.update((list) => [saved, ...list.filter((s) => s.id !== saved.id)]);
        if (stillActive) {
          this.sketchLastSaved = {
            title: saved.title,
            content: saved.content,
            page: saved.page,
            group_id: saved.group_id,
          };
        }
        this.sketchSaving.set(false);
        if (stillActive) this.sketchSaveStatus.set('saved');
        this.scheduleReaderStateSave();
        if (queued && stillActive) {
          this.sketchSaveQueued = false;
          this.scheduleSketchAutosave();
        } else if (queued) {
          this.sketchSaveQueued = false;
        }
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not save sketch');
        this.sketchSaving.set(false);
        this.sketchSaveStatus.set('error');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  // --- Study notes (Markdown) ----------------------------------------------
  toggleNotes() {
    const open = !this.notesOpen();
    this.notesOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.diagramsOpen.set(false);
      this.closeSketchesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      if (!this.notesLoaded()) this.loadNotes();
    }
    this.scheduleReaderStateSave();
  }

  private loadNotes(afterLoad?: () => void) {
    this.notes.list(this.bookId).subscribe({
      next: (items) => {
        this.noteList.set(items);
        this.notesLoaded.set(true);
        afterLoad?.();
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not load notes');
        this.notesError.set(message);
        this.notify.error(message);
      },
    });
  }

  private restoreNotesState(state: ReaderState) {
    const activeId = state.notes.view === 'edit' ? state.notes.active_id : null;
    this.loadNotes(() => {
      if (!this.notesOpen()) return;
      if (!activeId) {
        this.noteView.set('list');
        return;
      }
      const note = this.noteList().find((n) => n.id === activeId);
      if (note) {
        this.setActiveNote(note);
      } else {
        this.notes.get(this.bookId, activeId).subscribe({
          next: (item) => {
            if (!this.notesOpen()) return;
            this.noteList.update((list) => [item, ...list.filter((n) => n.id !== item.id)]);
            this.setActiveNote(item);
          },
          error: () => this.noteView.set('list'),
        });
      }
    });
  }

  newNote() {
    this.activeNote.set(null);
    this.noteTitle.set('Untitled note');
    this.noteContent.set('');
    this.notePage.set(this.currentPage());
    this.notesError.set(null);
    this.noteView.set('edit');
    this.scheduleReaderStateSave();
  }

  openNote(note: Note) {
    this.setActiveNote(note);
    this.scheduleReaderStateSave();
  }

  private setActiveNote(note: Note) {
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
    this.scheduleReaderStateSave();
  }

  setNoteSearch(value: string) {
    this.noteSearch.set(value);
    this.scheduleReaderStateSave();
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
        this.scheduleReaderStateSave();
        this.notify.success('Note saved');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not save note');
        this.notesError.set(message);
        this.notify.error(message);
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
        this.scheduleReaderStateSave();
        this.notify.success('Note deleted');
      },
      error: (err) => {
        const message = this.errorText(err, 'Could not delete note');
        this.notesError.set(message);
        this.notify.error(message);
      },
    });
  }
}
