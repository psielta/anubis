import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT, Location } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { KatexOptions, MarkdownComponent } from 'ngx-markdown';
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
import { TranslationService } from '../../core/services/translation';
import { DiagramsService } from '../../core/services/diagrams';
import { NotesService } from '../../core/services/notes';
import { SketchesService } from '../../core/services/sketches';
import { LatexNotebooksService } from '../../core/services/latex-notebooks';
import { WordDocumentsService } from '../../core/services/word-documents';
import { ExerciseResolutionsService } from '../../core/services/exercise-resolutions';
import { TocService } from '../../core/services/toc';
import { Book, ReaderPanel, ReaderState } from '../../core/models/book.model';
import { StudyKind, StudyMessage, StudyRequest, StudyScope } from '../../core/models/study.model';
import { Diagram, DiagramType } from '../../core/models/diagram.model';
import { Note } from '../../core/models/note.model';
import { Sketch, SketchGroup } from '../../core/models/sketch.model';
import { LatexNotebook, LatexNotebookGroup } from '../../core/models/latex-notebook.model';
import { OnlyOfficeEditorConfig, WordDocument } from '../../core/models/word-document.model';
import {
  ExerciseAIMode,
  ExerciseAttempt,
  ExerciseChatMessage,
  ExerciseRegion,
  ExerciseResolution,
  ExerciseStatus,
} from '../../core/models/exercise-resolution.model';
import { ExcalidrawCanvas } from './excalidraw-canvas/excalidraw-canvas';
import { ExerciseCrop } from './exercise-crop/exercise-crop';
import { AreaSelectDirective, AreaSelection } from './area-select.directive';
import { MermaidPreview } from './mermaid-preview/mermaid-preview';
import { NoteEditor } from './note-editor/note-editor';
import { LatexEditor } from './latex-editor/latex-editor';
import { OnlyOfficeEditor } from './onlyoffice-editor/onlyoffice-editor';
import { ReaderPrefsService } from '../../core/services/reader-prefs';
import { PanelResizerDirective } from './panel-resizer.directive';
import { NotificationsService } from '../../core/services/notifications';

// Served as a static asset (see angular.json); must be an absolute URL so
// production nginx does not fall through to the SPA index.html.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// KaTeX (for rendering $…$/$$…$$ in the AI and translation Markdown) loads
// lazily: the CSS is a static asset and the JS globals are imported on demand,
// keeping them out of the initial bundle. ngx-markdown's `katex` plugin reads
// the `katex`/`renderMathInElement` window globals at render time.
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

interface LatexSection {
  group: LatexNotebookGroup | null;
  notebooks: LatexNotebook[];
}

interface ReaderCommand {
  id: string;
  group: string;
  label: string;
  meta: string;
  page: number;
  preferLabel: boolean;
  depth: number;
  search: string;
}

interface ReaderCommandSection {
  title: string;
  items: ReaderCommand[];
}

interface ChapterContext {
  title: string;
  from: number;
  to: number;
}

interface PdfTextItemLike {
  str: string;
  transform: unknown[];
  width: number;
  height: number;
}

type ReaderShortcutAction =
  | 'assistant'
  | 'diagrams'
  | 'notes'
  | 'sketches'
  | 'latex'
  | 'word'
  | 'exercises'
  | 'crop'
  | 'contents'
  | 'contentTree'
  | 'translate'
  | 'commandPalette';

const SAVE_DEBOUNCE_MS = 1200;
const AUTO_TRANSLATE_DEBOUNCE_MS = 500;
const READER_STATE_DEBOUNCE_MS = 800;
const SKETCH_AUTOSAVE_MS = 1500;
const LATEX_AUTOSAVE_MS = 1500;
const EXERCISE_AUTOSAVE_MS = 1500;

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
    LatexEditor,
    OnlyOfficeEditor,
    ExerciseCrop,
    AreaSelectDirective,
    PanelResizerDirective,
  ],
  templateUrl: './reader.html',
  styleUrl: './reader.scss',
})
export class Reader implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private location = inject(Location);
  private document = inject(DOCUMENT);
  private library = inject(LibraryService);
  private study = inject(StudyService);
  private translation = inject(TranslationService);
  private diagrams = inject(DiagramsService);
  private notes = inject(NotesService);
  private sketches = inject(SketchesService);
  private latexNotebooks = inject(LatexNotebooksService);
  private wordDocuments = inject(WordDocumentsService);
  private exercises = inject(ExerciseResolutionsService);
  private tocService = inject(TocService);
  private prefs = inject(ReaderPrefsService);
  private notify = inject(NotificationsService);

  protected readonly panelWidth = this.prefs.panelWidth;
  protected readonly resizablePanelOpen = computed(
    () =>
      this.panelOpen() ||
      this.translateOpen() ||
      this.tocOpen() ||
      this.contentTreeOpen() ||
      this.notesOpen() ||
      this.diagramsOpen() ||
      (this.sketchesOpen() && !this.sketchFocus()) ||
      (this.latexOpen() && !this.latexFocus()) ||
      (this.wordOpen() && !this.wordFocus()) ||
      (this.exercisesOpen() && !this.exerciseFocus()),
  );

  private viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private commandPaletteInput = viewChild<ElementRef<HTMLInputElement>>('commandPaletteInput');
  private excalidrawCanvas = viewChild(ExcalidrawCanvas);
  private noteEditor = viewChild(NoteEditor);
  private latexEditor = viewChild(LatexEditor);
  private exerciseLatexEditor = viewChild('exLatexEditor', { read: LatexEditor });
  private exerciseSketchCanvas = viewChild('exSketchCanvas', { read: ExcalidrawCanvas });

  protected readonly book = signal<Book | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly pageCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly pageLabels = signal<string[]>([]);
  protected readonly detectedPageLabels = signal<(string | null)[]>([]);
  protected readonly pageNumberOffset = signal<number | null>(null);
  protected readonly currentPageReadout = computed(() => this.pageReadout(this.currentPage()));
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
    this.buildContentTreeMermaid(this.book()?.title ?? 'Livro', this.toc()),
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
  protected readonly shortcuts = {
    assistant: 'Alt+Shift+A',
    diagrams: 'Alt+Shift+D',
    notes: 'Alt+Shift+N',
    sketches: 'Alt+Shift+S',
    latex: 'Alt+Shift+L',
    word: 'Alt+Shift+W',
    exercises: 'Alt+Shift+X',
    crop: 'Alt+Shift+E',
    contents: 'Alt+Shift+C',
    contentTree: 'Alt+Shift+M',
    translate: 'Alt+Shift+T',
    commandPalette: 'Ctrl+K',
    commandPaletteAlt: 'Alt+Shift+K',
  } as const;

  // AI study assistant
  protected readonly panelOpen = signal(false);
  protected readonly aiScope = signal<StudyScope>('chapter');
  protected readonly aiCustomPageFrom = signal<number | null>(null);
  protected readonly aiCustomPageTo = signal<number | null>(null);
  protected readonly aiCustomRange = computed(() => {
    const from = this.aiCustomPageFrom();
    const to = this.aiCustomPageTo();
    const total = this.pageCount();
    if (!from || !to || to < from) return null;
    if (total && (from > total || to > total)) return null;
    return { from, to };
  });
  protected readonly aiCustomRangeInvalid = computed(() => {
    if (this.aiScope() !== 'pages') return false;
    const from = this.aiCustomPageFrom();
    const to = this.aiCustomPageTo();
    const total = this.pageCount();
    if (!from || !to) return true;
    return to < from || (!!total && (from > total || to > total));
  });
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
  protected readonly pendingVisualSelection = signal<AreaSelection | null>(null);
  private historyLoaded = false;
  private aiController: AbortController | null = null;

  // Page translation (pt-BR)
  protected readonly translateOpen = signal(false);
  protected readonly translatedMarkdown = signal('');
  protected readonly translateBusy = signal(false);
  protected readonly translateError = signal<string | null>(null);
  protected readonly translatedPage = signal<number | null>(null);
  protected readonly autoTranslate = this.prefs.autoTranslate;
  protected readonly translatedPageReadout = computed(() => {
    const p = this.translatedPage();
    return p ? this.pageReadout(p) : '';
  });
  private translationCache = new Map<number, string>();
  private translateAbort: AbortController | null = null;
  private translatingPage = 0;
  private autoTranslateTimer: ReturnType<typeof setTimeout> | null = null;

  // KaTeX math rendering for the AI/translation Markdown panels.
  protected readonly katexReady = signal(false);
  protected readonly katexOptions: KatexOptions = { throwOnError: false };

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

  // LaTeX notebooks (math worksheets)
  protected readonly latexOpen = signal(false);
  protected readonly latexView = signal<'list' | 'edit'>('list');
  protected readonly latexList = signal<LatexNotebook[]>([]);
  protected readonly latexGroups = signal<LatexNotebookGroup[]>([]);
  protected readonly latexLoaded = signal(false);
  protected readonly latexError = signal<string | null>(null);
  protected readonly latexSearch = signal('');
  protected readonly selectedLatexGroupId = signal<number | null>(null);
  protected readonly activeLatex = signal<LatexNotebook | null>(null);
  protected readonly latexTitle = signal('');
  protected readonly latexContent = signal('');
  protected readonly latexPage = signal<number | null>(null);
  protected readonly latexGroupId = signal<number | null>(null);
  protected readonly latexSaving = signal(false);
  protected readonly latexSaveStatus = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  protected readonly latexFocus = signal(false);
  protected readonly filteredLatex = computed(() => {
    const q = this.latexSearch().trim().toLowerCase();
    const list = this.latexList();
    if (!q) return list;
    return list.filter((n) => n.title.toLowerCase().includes(q));
  });
  protected readonly latexSections = computed<LatexSection[]>(() => {
    const notebooks = this.filteredLatex();
    const groups = this.latexGroups();
    const sections: LatexSection[] = groups.map((group) => ({
      group,
      notebooks: notebooks.filter((n) => n.group_id === group.id),
    }));
    const ungrouped = notebooks.filter((n) => n.group_id == null);
    if (ungrouped.length || !sections.length) {
      sections.push({ group: null, notebooks: ungrouped });
    }
    return sections;
  });

  // Word documents (ONLYOFFICE)
  protected readonly wordOpen = signal(false);
  protected readonly wordView = signal<'list' | 'edit'>('list');
  protected readonly wordList = signal<WordDocument[]>([]);
  protected readonly wordLoaded = signal(false);
  protected readonly wordError = signal<string | null>(null);
  protected readonly wordSearch = signal('');
  protected readonly activeWord = signal<WordDocument | null>(null);
  protected readonly wordTitle = signal('');
  protected readonly wordPage = signal<number | null>(null);
  protected readonly wordDetailsSaving = signal(false);
  protected readonly wordEditorLoading = signal(false);
  protected readonly wordFocus = signal(false);
  protected readonly wordEditorConfig = signal<OnlyOfficeEditorConfig | null>(null);
  protected readonly wordEditorKey = signal(0);
  protected readonly filteredWord = computed(() => {
    const q = this.wordSearch().trim().toLowerCase();
    const list = this.wordList();
    if (!q) return list;
    return list.filter((doc) => doc.title.toLowerCase().includes(q));
  });

  // Exercise resolutions (cropped exercises → solving workspace)
  protected readonly cropMode = signal(false);
  protected readonly assistantCropMode = signal(false);
  protected readonly areaSelectActive = computed(() => this.cropMode() || this.assistantCropMode());
  protected readonly cropDraft = signal<AreaSelection | null>(null);
  protected readonly cropDraftTitle = signal('');
  protected readonly cropDraftStatement = signal('');
  protected readonly cropAnchorTop = signal(0);
  protected readonly cropAnchorLeft = signal(0);
  protected readonly exercisesOpen = signal(false);
  protected readonly exerciseView = signal<'list' | 'edit'>('list');
  protected readonly exerciseList = signal<ExerciseResolution[]>([]);
  protected readonly exercisesLoaded = signal(false);
  protected readonly exercisesError = signal<string | null>(null);
  protected readonly exerciseSearch = signal('');
  protected readonly activeExercise = signal<ExerciseResolution | null>(null);
  protected readonly exerciseTitle = signal('');
  protected readonly exerciseStatement = signal('');
  protected readonly editingStatement = signal(false);
  protected readonly exerciseLatex = signal('');
  protected readonly exerciseSketch = signal('');
  protected readonly exerciseStatus = signal<ExerciseStatus>('pending');
  protected readonly exerciseTab = signal<'latex' | 'sketch'>('latex');
  protected readonly exerciseEpoch = signal(0); // bump to force-remount the editors
  protected readonly exerciseSaving = signal(false);
  protected readonly exerciseSaveStatus = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
  protected readonly exerciseFocus = signal(false);
  protected readonly readerPdfDoc = signal<PDFDocumentProxy | null>(null);
  // Attempt history ("ver resolução anterior")
  protected readonly attemptsOpen = signal(false);
  protected readonly attemptList = signal<ExerciseAttempt[]>([]);
  protected readonly attemptsLoading = signal(false);
  // Exercise AI (clean statement / hint / review)
  protected readonly exerciseAiBusy = signal(false);
  protected readonly exerciseAiMode = signal<ExerciseAIMode | null>(null);
  protected readonly exerciseAiText = signal('');
  protected readonly exerciseAiError = signal<string | null>(null);
  // Leveled hints (up to 3) — independent of the single "Dica" so both coexist.
  protected readonly hintLevels = signal<{ level: number; text: string }[]>([]);
  protected readonly hintStreaming = signal('');
  protected readonly hintBusy = signal(false);
  protected readonly hintError = signal<string | null>(null);
  protected readonly nextHintLevel = computed(() => this.hintLevels().length + 1);
  // Persistent tutor chat about the exercise (history kept server-side).
  protected readonly askInput = signal('');
  protected readonly chatMessages = signal<ExerciseChatMessage[]>([]);
  protected readonly chatStreaming = signal('');
  protected readonly chatBusy = signal(false);
  protected readonly chatError = signal<string | null>(null);
  protected readonly filteredExercises = computed(() => {
    const q = this.exerciseSearch().trim().toLowerCase();
    const list = this.exerciseList();
    if (!q) return list;
    return list.filter(
      (e) => e.title.toLowerCase().includes(q) || e.statement.toLowerCase().includes(q),
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
  private printedPageIndexPromise: Promise<void> | null = null;

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
  private sketchLastSaved: {
    title: string;
    content: string;
    page: number | null;
    group_id: number | null;
  } | null = null;
  private latexAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private latexSaveQueued = false;
  private latexLastSaved: {
    title: string;
    content: string;
    page: number | null;
    group_id: number | null;
  } | null = null;
  private exerciseAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private exerciseSaveQueued = false;
  private exerciseLastSaved: {
    title: string;
    statement: string;
    latex_content: string;
    sketch_content: string;
  } | null = null;
  private exerciseAiController: AbortController | null = null;
  private hintController: AbortController | null = null;
  private chatController: AbortController | null = null;
  private readonly readerKeydown = (event: KeyboardEvent) => this.handleReaderKeydown(event);

  constructor() {
    // Auto-translate: when enabled and the panel is open, translate each new page.
    effect(() => {
      const page = this.currentPage();
      if (!this.autoTranslate() || !this.translateOpen()) return;
      this.scheduleAutoTranslate(page);
    });
  }

  ngOnInit() {
    this.bookId = Number(this.route.snapshot.paramMap.get('id'));
    if (!this.bookId) {
      this.fail('Livro inválido');
      return;
    }
    this.document.addEventListener('keydown', this.readerKeydown);
    void this.initKatex();
    this.library.get(this.bookId).subscribe({
      next: (book) => {
        this.book.set(book);
        if (book.file_format !== 'pdf') {
          this.fail('Este formato de livro não pode ser lido no app');
          return;
        }
        this.resumePage = book.last_page && book.last_page > 1 ? book.last_page : null;
        this.lastSavedPage = book.last_page ?? 0;
        this.applySavedReaderState(book.reader_state);
        this.loadFile(this.bookId);
      },
      error: () => this.fail('Livro não encontrado'),
    });
  }

  ngAfterViewInit() {
    this.tryInit();
  }

  ngOnDestroy() {
    this.document.removeEventListener('keydown', this.readerKeydown);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flushProgress();
    this.flushSketchAutosave();
    this.flushLatexAutosave();
    this.flushExerciseAutosave();
    if (this.readerStateTimer) clearTimeout(this.readerStateTimer);
    this.flushReaderState();
    this.aiController?.abort();
    this.translateAbort?.abort();
    if (this.autoTranslateTimer) clearTimeout(this.autoTranslateTimer);
    this.exerciseAiController?.abort();
    this.hintController?.abort();
    this.chatController?.abort();
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

  /** Load KaTeX (CSS + JS globals) so ngx-markdown can render $…$/$$…$$ math. */
  private async initKatex(): Promise<void> {
    ensureKatexCss();
    const w = window as unknown as { katex?: unknown; renderMathInElement?: unknown };
    try {
      if (!w.katex) w.katex = (await import('katex')).default;
      if (!w.renderMathInElement) {
        w.renderMathInElement = (await import('katex/contrib/auto-render')).default;
      }
      this.katexReady.set(true);
    } catch {
      // If KaTeX fails to load, Markdown still renders — just without math.
      this.katexReady.set(false);
    }
  }

  goBack() {
    const state = this.location.getState() as { navigationId?: number } | null;
    if ((state?.navigationId ?? 0) > 1) {
      this.location.back();
      return;
    }
    void this.router.navigateByUrl('/library');
  }

  private loadFile(id: number) {
    this.library.download(id).subscribe({
      next: async (blob) => {
        this.data = await blob.arrayBuffer();
        this.loading.set(false);
        this.tryInit();
      },
      error: () => this.fail('Não foi possível abrir este livro'),
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
      this.readerPdfDoc.set(this.pdfDoc);
      this.pageCount.set(this.pdfDoc.numPages);
      await this.loadPageLabels();
      await this.estimatePrintedPageOffset();
      void this.buildDetectedPageLabelIndex();

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
      this.error.set('Não foi possível renderizar este PDF');
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
    this.updateCurrentPageFromScroll(el);
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
    const page = this.clampPage(num);
    const wrap = el.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`);
    if (!wrap) return;
    el.scrollTop = Math.max(0, wrap.offsetTop - 12);
    this.updateCurrentPageFromScroll(el);
    requestAnimationFrame(() => this.updateCurrentPageFromScroll(el));
  }

  goToPage(page: number, preferLabel = true) {
    const el = this.viewport()?.nativeElement;
    if (el) this.scrollToPage(el, this.resolveNavigationPage(page, preferLabel));
  }

  goToTocPage(page: number) {
    this.goToPage(page, this.tocCustom());
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
    this.goToPage(command.page, command.preferLabel);
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
      sections.push({ title: 'Páginas', items: [pageCommand] });
    }

    const contents = items
      .filter((item): item is TocItem & { page: number } => item.page != null && item.page > 0)
      .map((item, index) => this.tocCommand(item, index))
      .filter((command) => !normalizedQuery || command.search.includes(normalizedQuery));

    if (contents.length) {
      sections.push({ title: 'Sumário', items: contents });
    }

    return sections;
  }

  private tocCommand(item: TocItem & { page: number }, index: number): ReaderCommand {
    const title = item.title.trim() || 'Seção sem título';
    const depth = Math.max(0, Math.min(item.depth, 4));
    const preferLabel = this.tocCustom();
    const targetPage = this.resolveNavigationPage(item.page, preferLabel);
    const displayPage = this.displayTocPage(item.page);
    const meta =
      targetPage !== item.page ? `p. ${displayPage} · PDF ${targetPage}` : `p. ${displayPage}`;
    return {
      id: `toc-${index}-${item.page}`,
      group: 'Sumário',
      label: title,
      meta,
      page: item.page,
      preferLabel,
      depth,
      search: this.normalizeCommandQuery(`${title} ${meta} ${item.page} ${targetPage}`),
    };
  }

  private pageCommandForQuery(query: string, pageCount: number): ReaderCommand | null {
    const raw = query.trim();
    if (!raw) return null;

    const labeledPage = this.pageLabelToPhysicalPage(raw);
    if (labeledPage) {
      return {
        id: `page-label-${this.normalizePageLabel(raw)}-${labeledPage}`,
        group: 'Páginas',
        label: `Ir para a página ${raw}`,
        meta: labeledPage === Number(raw) ? `${labeledPage} / ${pageCount}` : `PDF ${labeledPage}`,
        page: labeledPage,
        preferLabel: false,
        depth: 0,
        search: this.normalizeCommandQuery(`${raw} ${labeledPage}`),
      };
    }

    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) return null;
    return {
      id: `page-${page}`,
      group: 'Páginas',
      label: `Ir para a página ${page}`,
      meta: `${page} / ${pageCount}`,
      page,
      preferLabel: false,
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

  private handleReaderKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;

    if (event.key === 'Escape' && this.commandPaletteOpen()) {
      event.preventDefault();
      this.closeCommandPalette();
      return;
    }

    const action = this.readerShortcutAction(event);
    if (!action || this.shouldIgnoreReaderShortcut(event.target)) return;

    event.preventDefault();
    this.runReaderShortcut(action);
  }

  private readerShortcutAction(event: KeyboardEvent): ReaderShortcutAction | null {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      return event.code === 'KeyK' ? 'commandPalette' : null;
    }

    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
    switch (event.code) {
      case 'KeyA':
        return 'assistant';
      case 'KeyD':
        return 'diagrams';
      case 'KeyN':
        return 'notes';
      case 'KeyS':
        return 'sketches';
      case 'KeyL':
        return 'latex';
      case 'KeyW':
        return 'word';
      case 'KeyX':
        return 'exercises';
      case 'KeyE':
        return 'crop';
      case 'KeyC':
        return 'contents';
      case 'KeyM':
        return 'contentTree';
      case 'KeyT':
        return 'translate';
      case 'KeyK':
        return 'commandPalette';
      default:
        return null;
    }
  }

  private runReaderShortcut(action: ReaderShortcutAction) {
    if (this.loading() || this.error()) return;
    switch (action) {
      case 'assistant':
        this.togglePanel();
        break;
      case 'diagrams':
        this.toggleDiagrams();
        break;
      case 'notes':
        this.toggleNotes();
        break;
      case 'sketches':
        this.toggleSketches();
        break;
      case 'latex':
        this.toggleLatex();
        break;
      case 'word':
        this.toggleWord();
        break;
      case 'exercises':
        this.toggleExercises();
        break;
      case 'crop':
        this.toggleCropMode();
        break;
      case 'contents':
        this.toggleToc();
        break;
      case 'contentTree':
        this.toggleContentTree();
        break;
      case 'translate':
        this.toggleTranslate();
        break;
      case 'commandPalette':
        this.openCommandPalette();
        break;
    }
  }

  private shouldIgnoreReaderShortcut(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const editable = target.closest(
      'input, textarea, select, [contenteditable="true"], app-note-editor, app-excalidraw-canvas, app-latex-editor, app-onlyoffice-editor',
    );
    if (editable) return true;
    return target instanceof HTMLElement && target.isContentEditable;
  }

  private async loadPageLabels() {
    if (!this.pdfDoc) {
      this.pageLabels.set([]);
      this.detectedPageLabels.set([]);
      this.pageNumberOffset.set(null);
      return;
    }
    try {
      const labels = await this.pdfDoc.getPageLabels();
      this.pageLabels.set(labels ?? []);
    } catch {
      this.pageLabels.set([]);
    }
  }

  private async estimatePrintedPageOffset() {
    if (!this.pdfDoc || this.pageLabels().length) {
      this.detectedPageLabels.set([]);
      this.pageNumberOffset.set(null);
      return;
    }

    const total = this.pdfDoc.numPages;
    this.detectedPageLabels.set(Array.from({ length: total }, () => null));
    const samples = new Set<number>();
    for (let page = 1; page <= Math.min(total, 28); page++) samples.add(page);
    for (const page of [40, 60, 100, 150, 200, 300]) {
      if (page <= total) samples.add(page);
    }

    const offsets: number[] = [];
    const labels = this.detectedPageLabels().slice();
    for (const page of [...samples].sort((a, b) => a - b)) {
      const detected = await this.detectPrintedPageNumber(page);
      if (detected == null) continue;
      labels[page - 1] = String(detected);
      const offset = detected - page;
      if (Math.abs(offset) <= 80) offsets.push(offset);
    }

    this.detectedPageLabels.set(labels);
    this.pageNumberOffset.set(this.mostFrequentOffset(offsets));
  }

  private mostFrequentOffset(offsets: number[]): number | null {
    if (!offsets.length) return null;
    const counts = new Map<number, number>();
    for (const offset of offsets) counts.set(offset, (counts.get(offset) ?? 0) + 1);
    const ranked = [...counts.entries()].sort(
      ([aOffset, aCount], [bOffset, bCount]) =>
        bCount - aCount || Math.abs(aOffset) - Math.abs(bOffset),
    );
    const [offset, count] = ranked[0];
    return count >= 2 ? offset : null;
  }

  private async buildDetectedPageLabelIndex() {
    if (!this.pdfDoc || this.pageLabels().length) return;
    if (this.printedPageIndexPromise) return this.printedPageIndexPromise;

    this.printedPageIndexPromise = (async () => {
      const total = this.pdfDoc?.numPages ?? 0;
      const labels = this.detectedPageLabels().slice();
      for (let page = 1; page <= total; page++) {
        if (!labels[page - 1]) {
          const detected = await this.detectPrintedPageNumber(page);
          if (detected != null) labels[page - 1] = String(detected);
        }
        if (page % 16 === 0 || page === total) {
          this.detectedPageLabels.set(labels.slice());
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    })();

    try {
      await this.printedPageIndexPromise;
    } finally {
      this.printedPageIndexPromise = null;
    }
  }

  private async detectPrintedPageNumber(physicalPage: number): Promise<number | null> {
    if (!this.pdfDoc) return null;
    try {
      const page = await this.pdfDoc.getPage(physicalPage);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      let best: { value: number; score: number } | null = null;
      for (const [index, item] of content.items.entries()) {
        if (!this.isPdfTextItem(item)) continue;
        const candidate = this.printedPageCandidate(
          item,
          index,
          content.items.length,
          viewport.width,
          viewport.height,
          physicalPage,
        );
        if (!candidate) continue;
        if (!best || candidate.score > best.score) best = candidate;
      }
      return best && best.score >= 100 ? best.value : null;
    } catch {
      return null;
    }
  }

  private isPdfTextItem(item: unknown): item is PdfTextItemLike {
    const value = item as Partial<PdfTextItemLike>;
    return (
      typeof value.str === 'string' &&
      Array.isArray(value.transform) &&
      typeof value.width === 'number' &&
      typeof value.height === 'number'
    );
  }

  private printedPageCandidate(
    item: PdfTextItemLike,
    index: number,
    totalItems: number,
    viewportWidth: number,
    viewportHeight: number,
    physicalPage: number,
  ): { value: number; score: number } | null {
    const text = item.str.trim();
    const pure = /^\d{1,4}$/.test(text);
    const headerText = /^(\d{1,4})\s+[A-ZÀ-Ú]/u.exec(text);
    const valueText = pure ? text : headerText?.[1];
    if (!valueText) return null;

    const value = Number(valueText);
    if (!Number.isInteger(value) || value < 1 || value > this.pageCount() + 150) return null;

    const x = Number(item.transform[4] ?? 0);
    const y = Number(item.transform[5] ?? 0);
    if (x < -80 || x > viewportWidth + 120) return null;

    const nearVerticalEdge = y < 85 || y > viewportHeight - 85;
    if (!nearVerticalEdge) return null;
    if (!pure && x > 170) return null;

    const nearHorizontalEdge = x < 170 || x + item.width > viewportWidth - 170;
    const nearDocumentOrderEdge = index < 14 || index > totalItems - 8;
    const delta = Math.abs(value - physicalPage);

    let score = y < 85 ? 45 : 20;
    if (nearHorizontalEdge) score += 25;
    if (nearDocumentOrderEdge) score += 25;
    score += pure ? 10 : 15;
    if (delta <= 120) score += 20;
    if (delta <= 40) score += 20;
    if (delta <= 15) score += 10;
    if (delta > 180) score -= 80;

    return { value, score };
  }

  private clampPage(page: number): number {
    const total = this.pageCount();
    if (!total) return Math.max(1, Math.round(page));
    return Math.max(1, Math.min(total, Math.round(page)));
  }

  private resolveNavigationPage(page: number, preferLabel: boolean): number {
    if (preferLabel) {
      const labeledPage = this.pageLabelToPhysicalPage(page);
      if (labeledPage) return labeledPage;
    }
    return this.clampPage(page);
  }

  private pageLabelForPhysicalPage(page: number): string | null {
    const embedded = this.pageLabels()[page - 1]?.trim();
    if (embedded) return embedded;
    const detected = this.detectedPageLabels()[page - 1]?.trim();
    if (detected) return detected;
    const offset = this.pageNumberOffset();
    return offset == null ? null : String(page + offset);
  }

  displayTocPage(page: number): string {
    if (this.tocCustom()) return String(page);
    return this.pageLabelForPhysicalPage(page) ?? String(page);
  }

  private pageReadout(page: number): string {
    const total = this.pageCount();
    const label = this.pageLabelForPhysicalPage(page);
    if (label && label !== String(page)) return `${label} (PDF ${page} / ${total})`;
    return `${page} / ${total}`;
  }

  private currentDisplayPageValue(): number {
    const label = this.pageLabelForPhysicalPage(this.currentPage());
    const page = Number(label);
    return Number.isInteger(page) && page > 0 ? page : this.currentPage();
  }

  private pageLabelToPhysicalPage(value: string | number): number | null {
    const target = this.normalizePageLabel(value);
    if (!target) return null;
    const targetNumber = this.normalizedNumericPageLabel(target);
    const labels = this.pageLabels();
    for (let index = 0; index < labels.length; index++) {
      const label = this.normalizePageLabel(labels[index]);
      if (label === target) return index + 1;
      if (targetNumber && this.normalizedNumericPageLabel(label) === targetNumber) {
        return index + 1;
      }
    }
    const detected = this.detectedPageLabels();
    for (let index = 0; index < detected.length; index++) {
      const detectedLabel = detected[index];
      const label = detectedLabel ? this.normalizePageLabel(detectedLabel) : '';
      if (label === target) return index + 1;
      if (targetNumber && this.normalizedNumericPageLabel(label) === targetNumber) {
        return index + 1;
      }
    }
    if (targetNumber) {
      const offset = this.pageNumberOffset();
      if (offset != null) {
        const page = Number(targetNumber) - offset;
        if (Number.isInteger(page) && page >= 1 && page <= this.pageCount()) return page;
      }
    }
    return null;
  }

  private normalizePageLabel(value: string | number): string {
    return String(value).trim().toLowerCase();
  }

  private normalizedNumericPageLabel(value: string): string | null {
    return /^\d+$/.test(value) ? String(Number(value)) : null;
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
    this.latexSearch.set(state.latex?.search ?? '');
    this.wordSearch.set(state.word?.search ?? '');
    this.exerciseSearch.set(state.exercises?.search ?? '');
    this.aiScope.set(state.study?.scope ?? 'chapter');
    this.aiCustomPageFrom.set(state.study?.custom_page_from ?? null);
    this.aiCustomPageTo.set(state.study?.custom_page_to ?? null);

    this.panelOpen.set(false);
    this.diagramsOpen.set(false);
    this.notesOpen.set(false);
    this.sketchesOpen.set(false);
    this.latexOpen.set(false);
    this.wordOpen.set(false);
    this.exercisesOpen.set(false);
    this.tocOpen.set(false);
    this.contentTreeOpen.set(false);
    this.translateOpen.set(false);

    switch (state.panel) {
      case 'assistant':
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
      case 'latex':
        this.latexOpen.set(true);
        this.restoreLatexState(state);
        break;
      case 'word':
        this.wordOpen.set(true);
        this.restoreWordState(state);
        break;
      case 'exercises':
        this.exercisesOpen.set(true);
        this.restoreExercisesState(state);
        break;
      case 'toc':
        this.tocOpen.set(true);
        this.tocDraft.set(this.cloneToc(this.toc()));
        break;
      case 'content_tree':
        this.contentTreeOpen.set(true);
        break;
      case 'translate':
        this.translateOpen.set(true);
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
    if (this.latexOpen()) return 'latex';
    if (this.wordOpen()) return 'word';
    if (this.exercisesOpen()) return 'exercises';
    if (this.tocOpen()) return 'toc';
    if (this.contentTreeOpen()) return 'content_tree';
    if (this.translateOpen()) return 'translate';
    return null;
  }

  private buildReaderState(): ReaderState {
    const activeNote = this.activeNote();
    const activeDiagram = this.activeDiagram();
    const activeSketch = this.activeSketch();
    const activeLatex = this.activeLatex();
    const activeWord = this.activeWord();
    const activeExercise = this.activeExercise();
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
      latex: {
        view: activeLatex && this.latexView() === 'edit' ? 'edit' : 'list',
        active_id: activeLatex?.id ?? null,
        active_group_id: this.selectedLatexGroupId(),
        search: this.latexSearch(),
      },
      word: {
        view: activeWord && this.wordView() === 'edit' ? 'edit' : 'list',
        active_id: activeWord?.id ?? null,
        search: this.wordSearch(),
      },
      exercises: {
        view: activeExercise && this.exerciseView() === 'edit' ? 'edit' : 'list',
        active_id: activeExercise?.id ?? null,
        search: this.exerciseSearch(),
      },
      study: {
        scope: this.aiScope(),
        custom_page_from: this.aiCustomPageFrom(),
        custom_page_to: this.aiCustomPageTo(),
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

  private closeLatexPanel() {
    if (!this.latexOpen()) return;
    this.flushLatexAutosave();
    this.latexFocus.set(false);
    this.latexOpen.set(false);
  }

  private closeWordPanel() {
    if (!this.wordOpen()) return;
    this.wordFocus.set(false);
    this.wordOpen.set(false);
    this.wordEditorConfig.set(null);
  }

  togglePanel() {
    const open = !this.panelOpen();
    this.panelOpen.set(open);
    if (open) {
      // The right-docked panels are mutually exclusive.
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      this.closeTranslatePanel();
      if (!this.historyLoaded) this.loadHistory();
    }
    this.scheduleReaderStateSave();
  }

  // --- Page translation (pt-BR) --------------------------------------------
  toggleTranslate() {
    const open = !this.translateOpen();
    this.translateOpen.set(open);
    if (open) {
      this.panelOpen.set(false);
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      this.translateCurrentPage();
    } else {
      this.translateAbort?.abort();
    }
    this.scheduleReaderStateSave();
  }

  private closeTranslatePanel() {
    if (!this.translateOpen()) return;
    this.translateAbort?.abort();
    this.translateOpen.set(false);
  }

  translateCurrentPage(force = false) {
    if (this.loading() || this.error() || !this.bookId) return;
    const page = this.currentPage();
    if (!page) return;
    if (!force) {
      if (this.translateBusy() && this.translatingPage === page) return;
      if (this.translatedPage() === page && this.translatedMarkdown()) return;
      const cached = this.translationCache.get(page);
      if (cached) {
        this.translateAbort?.abort();
        this.translatingPage = page;
        this.translateBusy.set(false);
        this.translateError.set(null);
        this.translatedMarkdown.set(cached);
        this.translatedPage.set(page);
        return;
      }
    }

    this.translateAbort?.abort();
    this.translateAbort = new AbortController();
    this.translatingPage = page;
    this.translateBusy.set(true);
    this.translateError.set(null);
    this.translatedMarkdown.set('');
    this.translatedPage.set(page);

    void this.translation.translate(
      this.bookId,
      { page, force },
      {
        onDelta: (t) => this.translatedMarkdown.update((v) => v + t),
        onDone: () => {
          this.translationCache.set(page, this.translatedMarkdown());
          this.translateBusy.set(false);
        },
        onError: (message) => {
          this.translateError.set(message);
          this.notify.error(message);
          this.translateBusy.set(false);
        },
      },
      this.translateAbort.signal,
    );
  }

  retranslate() {
    this.translateCurrentPage(true);
  }

  setAutoTranslate(on: boolean) {
    this.prefs.setAutoTranslate(on);
    if (on && this.translateOpen()) this.translateCurrentPage();
  }

  toggleAutoTranslate() {
    this.setAutoTranslate(!this.autoTranslate());
  }

  private scheduleAutoTranslate(page: number) {
    if (this.autoTranslateTimer) clearTimeout(this.autoTranslateTimer);
    this.autoTranslateTimer = setTimeout(() => {
      this.autoTranslateTimer = null;
      if (!this.autoTranslate() || !this.translateOpen()) return;
      if (this.currentPage() !== page) return;
      this.translateCurrentPage();
    }, AUTO_TRANSLATE_DEBOUNCE_MS);
  }

  captureSelection() {
    if (this.areaSelectActive()) return;
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

  onReaderScroll() {
    this.hideSelectionButton();
    this.updateCurrentPageFromScroll();
  }

  private updateCurrentPageFromScroll(
    el: HTMLElement | undefined = this.viewport()?.nativeElement,
  ) {
    if (!el || !this.pages.length) return;
    const anchor = el.scrollTop + Math.min(160, el.clientHeight * 0.28);
    let best = this.pages[0];
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const page of this.pages) {
      const top = page.wrap.offsetTop;
      const bottom = top + page.wrap.offsetHeight;
      if (anchor >= top && anchor < bottom) {
        best = page;
        break;
      }

      const distance = anchor < top ? top - anchor : anchor - bottom;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = page;
      }
    }

    if (best.num !== this.currentPage()) {
      this.currentPage.set(best.num);
    }
    this.scheduleSave();
  }

  hideSelectionButton() {
    if (this.selectionText()) this.selectionText.set('');
  }

  askSelection() {
    const text = this.selectionText();
    if (!text) return;
    this.pendingSelection.set(text);
    this.pendingVisualSelection.set(null);
    this.selectionText.set('');
    window.getSelection()?.removeAllRanges();
    if (!this.panelOpen()) {
      this.diagramsOpen.set(false);
      this.notesOpen.set(false);
      this.closeSketchesPanel();
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      this.closeTranslatePanel();
      this.panelOpen.set(true);
      if (!this.historyLoaded) this.loadHistory();
      this.scheduleReaderStateSave();
    }
  }

  clearPendingSelection() {
    this.pendingSelection.set(null);
  }

  clearPendingVisualSelection() {
    this.pendingVisualSelection.set(null);
  }

  setAiScope(scope: StudyScope) {
    this.aiScope.set(scope);
    this.scheduleReaderStateSave();
  }

  setAiCustomPageFrom(value: string) {
    this.aiCustomPageFrom.set(this.parseContextPageInput(value));
    this.scheduleReaderStateSave();
  }

  setAiCustomPageTo(value: string) {
    this.aiCustomPageTo.set(this.parseContextPageInput(value));
    this.scheduleReaderStateSave();
  }

  private parseContextPageInput(value: string): number | null {
    const raw = value.trim();
    if (!raw) return null;
    const labeled = this.pageLabelToPhysicalPage(raw);
    if (labeled) return labeled;
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1) return null;
    return page;
  }

  startAssistantImageSelection() {
    if (this.loading() || this.error()) return;
    this.cropMode.set(false);
    this.cropDraft.set(null);
    this.assistantCropMode.set(true);
    this.hideSelectionButton();
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
    const context = this.chapterContext();
    return context ? { from: context.from, to: context.to } : null;
  }

  chapterContextLabel(): string {
    const context = this.chapterContext();
    if (!context) return 'Capítulo atual indisponível';
    return `${context.title} · PDF pp. ${context.from}-${context.to}`;
  }

  private chapterContext(): ChapterContext | null {
    const preferLabel = this.tocCustom();
    const entries = this.toc()
      .map((entry) => {
        if (entry.page == null) return null;
        const page = this.resolveNavigationPage(entry.page, preferLabel);
        return page == null ? null : { title: entry.title.trim() || 'Seção sem título', page };
      })
      .filter((entry): entry is { title: string; page: number } => entry != null);
    if (!entries.length) return null;
    const page = this.currentPage();
    let current = entries[0];
    for (const entry of entries) {
      if (entry.page <= page && entry.page >= current.page) current = entry;
    }
    const later = entries
      .map((entry) => entry.page)
      .filter((p) => p > current.page)
      .sort((a, b) => a - b);
    const to = later.length ? later[0] - 1 : this.pageCount();
    return { title: current.title, from: current.page, to: Math.max(current.page, to) };
  }

  effectiveAiScope(): StudyScope {
    if (this.aiScope() === 'chapter') return this.chapterRange() ? 'chapter' : 'book';
    if (this.aiScope() === 'pages') return this.aiCustomRange() ? 'pages' : 'book';
    return 'book';
  }

  send(kind: StudyKind, input?: HTMLInputElement) {
    if (this.aiBusy()) return;
    const selection = kind === 'chat' ? this.pendingSelection() : null;
    const visualSelection = kind === 'chat' ? this.pendingVisualSelection() : null;
    let question: string | undefined;
    if (kind === 'chat') {
      question = input?.value.trim() || undefined;
      if (!question && !selection && !visualSelection) return;
    }

    const body: StudyRequest = { kind, scope: this.aiScope() };
    const contextRange =
      body.scope === 'chapter'
        ? this.chapterRange()
        : body.scope === 'pages'
          ? this.aiCustomRange()
          : null;
    if (body.scope === 'pages' && !contextRange) {
      const message = 'Informe um intervalo de páginas válido para o contexto personalizado.';
      this.aiError.set(message);
      this.notify.error(message);
      return;
    }
    if (body.scope === 'chapter' && !contextRange) {
      body.scope = 'book';
    } else if (contextRange) {
      body.page_from = contextRange.from;
      body.page_to = contextRange.to;
    }

    if (visualSelection) {
      body.visual_selection = {
        page: visualSelection.page,
        region: visualSelection.region,
      };
    }
    if (selection) {
      body.selection = selection;
    }
    if (question) body.question = question;

    let display: string | null = null;
    if (kind === 'chat') {
      const image = visualSelection ? `[Imagem do PDF p. ${visualSelection.page}] ` : '';
      const quote = selection
        ? `“${selection.slice(0, 120)}${selection.length > 120 ? '…' : ''}” `
        : '';
      display = (image + quote + (question ?? '')).trim() || null;
    }

    this.aiError.set(null);
    this.thinking.set('');
    this.streamingAnswer.set('');
    this.pendingQuestion.set(display);
    this.pendingSelection.set(null);
    this.pendingVisualSelection.set(null);
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
        this.notify.success('Histórico de estudo limpo');
      },
      error: (err) => this.notify.error(this.errorText(err, 'Não foi possível limpar o histórico de estudo')),
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
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.contentTreeOpen.set(false);
      this.closeTranslatePanel();
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
    this.tocDraft.update((list) => list.map((item, i) => (i === index ? { ...item, page } : item)));
  }

  addTocEntry() {
    this.tocDraft.update((list) => [
      ...list,
      { title: 'Nova seção', page: this.currentDisplayPageValue(), depth: 0 },
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
        void this.applySavedToc(book).then(() => this.notify.success('Sumário salvo'));
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível salvar o sumário');
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
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.tocOpen.set(false);
      this.closeTranslatePanel();
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
      const page = item.page ? this.displayTocPage(item.page) : null;
      const title = item.page ? `${prefix}${item.title} (p. ${page})` : `${prefix}${item.title}`;
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
    const title = `Árvore de conteúdo de ${this.book()?.title?.trim() || 'Livro'}`;
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
          this.notify.success('Árvore de conteúdo salva como diagrama');
        },
        error: (err) => {
          const message = this.errorText(err, 'Não foi possível salvar a árvore de conteúdo');
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
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      this.closeTranslatePanel();
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
        const message = this.errorText(err, 'Não foi possível carregar os diagramas');
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
    this.draftTitle.set(type === 'mermaid' ? 'Diagrama sem título' : 'Desenho sem título');
    this.draftContent.set(type === 'mermaid' ? 'graph TD\n  A[Início] --> B[Fim]' : '');
    this.draftPage.set(this.currentDisplayPageValue());
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
        this.notify.success('Diagrama salvo');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível salvar o diagrama');
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
        this.notify.success('Diagrama excluído');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir o diagrama');
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
    this.closeTranslatePanel();
    this.closeLatexPanel();
    this.closeWordPanel();
    this.closeExercisesPanel();
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
        const message = this.errorText(err, 'Não foi possível carregar os rascunhos');
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
    const name = window.prompt('Nome do grupo')?.trim();
    if (!name) return;
    this.sketches.createGroup(this.bookId, { name }).subscribe({
      next: (group) => {
        this.sketchGroups.update((groups) => [...groups, group]);
        this.selectedSketchGroupId.set(group.id);
        this.scheduleReaderStateSave();
        this.notify.success('Grupo criado');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível criar o grupo');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  renameSketchGroup(group: SketchGroup) {
    const name = window.prompt('Nome do grupo', group.name)?.trim();
    if (!name || name === group.name) return;
    this.sketches.updateGroup(this.bookId, group.id, { name }).subscribe({
      next: (saved) => {
        this.sketchGroups.update((groups) =>
          groups.map((item) => (item.id === saved.id ? saved : item)),
        );
        this.notify.success('Grupo renomeado');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível renomear o grupo');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  deleteSketchGroup(group: SketchGroup) {
    const ok = window.confirm(`Excluir "${group.name}"? Os rascunhos voltam para Sem grupo.`);
    if (!ok) return;
    this.sketches.removeGroup(this.bookId, group.id).subscribe({
      next: () => {
        this.sketchGroups.update((groups) => groups.filter((item) => item.id !== group.id));
        this.sketchList.update((items) =>
          items.map((item) => (item.group_id === group.id ? { ...item, group_id: null } : item)),
        );
        if (this.selectedSketchGroupId() === group.id) this.selectedSketchGroupId.set(null);
        if (this.sketchGroupId() === group.id) {
          this.sketchGroupId.set(null);
          this.scheduleSketchAutosave();
        }
        this.scheduleReaderStateSave();
        this.notify.success('Grupo excluído');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir o grupo');
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
        title: 'Rascunho sem título',
        content: '',
        group_id: targetGroupId,
        page: this.currentDisplayPageValue(),
      })
      .subscribe({
        next: (saved) => {
          this.sketchSaving.set(false);
          this.sketchSaveStatus.set('saved');
          this.sketchList.update((list) => [saved, ...list.filter((s) => s.id !== saved.id)]);
          this.setActiveSketch(saved);
          this.scheduleReaderStateSave();
          this.notify.success('Rascunho criado');
        },
        error: (err) => {
          const message = this.errorText(err, 'Não foi possível criar o rascunho');
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
    return new Date(sketch.updated_at).toLocaleDateString('pt-BR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  sketchGroupName(groupId: number | null): string {
    if (groupId == null) return 'Sem grupo';
    return this.sketchGroups().find((group) => group.id === groupId)?.name ?? 'Sem grupo';
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
        this.notify.success('Rascunho excluído');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir o rascunho');
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
      this.sketchesError.set('O título do rascunho não pode ficar vazio');
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
        const message = this.errorText(err, 'Não foi possível salvar o rascunho');
        this.sketchSaving.set(false);
        this.sketchSaveStatus.set('error');
        this.sketchesError.set(message);
        this.notify.error(message);
      },
    });
  }

  // --- LaTeX notebooks (math worksheets) -----------------------------------
  toggleLatex() {
    const open = !this.latexOpen();
    if (!open) {
      this.closeLatexPanel();
      this.scheduleReaderStateSave();
      return;
    }

    this.latexOpen.set(true);
    this.panelOpen.set(false);
    this.diagramsOpen.set(false);
    this.notesOpen.set(false);
    this.closeSketchesPanel();
    this.closeWordPanel();
    this.closeExercisesPanel();
    this.tocOpen.set(false);
    this.contentTreeOpen.set(false);
    this.closeTranslatePanel();
    this.latexError.set(null);
    if (!this.latexLoaded()) this.loadLatex();
    this.scheduleReaderStateSave();
  }

  private loadLatex(afterLoad?: () => void) {
    forkJoin({
      groups: this.latexNotebooks.listGroups(this.bookId),
      notebooks: this.latexNotebooks.list(this.bookId),
    }).subscribe({
      next: ({ groups, notebooks }) => {
        this.latexGroups.set(groups);
        this.latexList.set(notebooks);
        this.latexLoaded.set(true);
        afterLoad?.();
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível carregar os cadernos LaTeX');
        this.latexError.set(message);
        this.notify.error(message);
      },
    });
  }

  private restoreLatexState(state: ReaderState) {
    const latexState = state.latex;
    this.selectedLatexGroupId.set(latexState?.active_group_id ?? null);
    const activeId = latexState?.view === 'edit' ? latexState.active_id : null;
    this.loadLatex(() => {
      if (!this.latexOpen()) return;
      if (!activeId) {
        this.latexView.set('list');
        return;
      }
      const notebook = this.latexList().find((n) => n.id === activeId);
      if (notebook) {
        this.setActiveLatex(notebook);
      } else {
        this.latexNotebooks.get(this.bookId, activeId).subscribe({
          next: (item) => {
            if (!this.latexOpen()) return;
            this.latexList.update((list) => [item, ...list.filter((n) => n.id !== item.id)]);
            this.setActiveLatex(item);
          },
          error: () => this.latexView.set('list'),
        });
      }
    });
  }

  createLatexGroup() {
    const name = window.prompt('Nome do grupo')?.trim();
    if (!name) return;
    this.latexNotebooks.createGroup(this.bookId, { name }).subscribe({
      next: (group) => {
        this.latexGroups.update((groups) => [...groups, group]);
        this.selectedLatexGroupId.set(group.id);
        this.scheduleReaderStateSave();
        this.notify.success('Grupo criado');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível criar o grupo');
        this.latexError.set(message);
        this.notify.error(message);
      },
    });
  }

  renameLatexGroup(group: LatexNotebookGroup) {
    const name = window.prompt('Nome do grupo', group.name)?.trim();
    if (!name || name === group.name) return;
    this.latexNotebooks.updateGroup(this.bookId, group.id, { name }).subscribe({
      next: (saved) => {
        this.latexGroups.update((groups) =>
          groups.map((item) => (item.id === saved.id ? saved : item)),
        );
        this.notify.success('Grupo renomeado');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível renomear o grupo');
        this.latexError.set(message);
        this.notify.error(message);
      },
    });
  }

  deleteLatexGroup(group: LatexNotebookGroup) {
    const ok = window.confirm(`Excluir "${group.name}"? Os cadernos voltam para Sem grupo.`);
    if (!ok) return;
    this.latexNotebooks.removeGroup(this.bookId, group.id).subscribe({
      next: () => {
        this.latexGroups.update((groups) => groups.filter((item) => item.id !== group.id));
        this.latexList.update((items) =>
          items.map((item) => (item.group_id === group.id ? { ...item, group_id: null } : item)),
        );
        if (this.selectedLatexGroupId() === group.id) this.selectedLatexGroupId.set(null);
        if (this.latexGroupId() === group.id) {
          this.latexGroupId.set(null);
          this.scheduleLatexAutosave();
        }
        this.scheduleReaderStateSave();
        this.notify.success('Grupo excluído');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir o grupo');
        this.latexError.set(message);
        this.notify.error(message);
      },
    });
  }

  newLatex(groupId?: number | null) {
    if (this.latexSaving()) return;
    const targetGroupId = groupId === undefined ? this.selectedLatexGroupId() : groupId;
    this.flushLatexAutosave();
    this.latexSaving.set(true);
    this.latexSaveStatus.set('saving');
    this.latexError.set(null);
    this.latexNotebooks
      .create(this.bookId, {
        title: 'Caderno sem título',
        content: '',
        group_id: targetGroupId,
        page: this.currentDisplayPageValue(),
      })
      .subscribe({
        next: (saved) => {
          this.latexSaving.set(false);
          this.latexSaveStatus.set('saved');
          this.latexList.update((list) => [saved, ...list.filter((n) => n.id !== saved.id)]);
          this.setActiveLatex(saved);
          this.scheduleReaderStateSave();
          this.notify.success('Caderno criado');
        },
        error: (err) => {
          const message = this.errorText(err, 'Não foi possível criar o caderno');
          this.latexSaving.set(false);
          this.latexSaveStatus.set('error');
          this.latexError.set(message);
          this.notify.error(message);
        },
      });
  }

  openLatex(notebook: LatexNotebook) {
    if (this.activeLatex()?.id !== notebook.id) this.flushLatexAutosave();
    this.setActiveLatex(notebook);
    this.scheduleReaderStateSave();
  }

  private setActiveLatex(notebook: LatexNotebook) {
    this.activeLatex.set(notebook);
    this.latexTitle.set(notebook.title);
    this.latexContent.set(notebook.content);
    this.latexPage.set(notebook.page);
    this.latexGroupId.set(notebook.group_id);
    this.selectedLatexGroupId.set(notebook.group_id);
    this.latexLastSaved = {
      title: notebook.title,
      content: notebook.content,
      page: notebook.page,
      group_id: notebook.group_id,
    };
    this.latexSaveStatus.set('saved');
    this.latexError.set(null);
    this.latexView.set('edit');
  }

  backToLatexList() {
    this.flushLatexAutosave();
    this.latexFocus.set(false);
    this.latexView.set('list');
    this.scheduleReaderStateSave();
  }

  setLatexSearch(value: string) {
    this.latexSearch.set(value);
    this.scheduleReaderStateSave();
  }

  selectLatexGroup(groupId: number | null) {
    this.selectedLatexGroupId.set(groupId);
    this.scheduleReaderStateSave();
  }

  setLatexTitle(value: string) {
    this.latexTitle.set(value);
    this.scheduleLatexAutosave();
  }

  setLatexPage(value: number) {
    this.latexPage.set(value && value > 0 ? value : null);
    this.scheduleLatexAutosave();
  }

  setLatexGroup(value: string) {
    const groupId = value ? Number(value) : null;
    this.latexGroupId.set(groupId != null && Number.isFinite(groupId) ? groupId : null);
    this.selectedLatexGroupId.set(this.latexGroupId());
    this.scheduleLatexAutosave();
    this.scheduleReaderStateSave();
  }

  onLatexSourceChange(source: string) {
    this.latexContent.set(source);
    this.scheduleLatexAutosave();
  }

  toggleLatexFocus() {
    this.latexFocus.update((value) => !value);
  }

  latexUpdatedLabel(notebook: LatexNotebook): string {
    return new Date(notebook.updated_at).toLocaleDateString('pt-BR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  latexGroupName(groupId: number | null): string {
    if (groupId == null) return 'Sem grupo';
    return this.latexGroups().find((group) => group.id === groupId)?.name ?? 'Sem grupo';
  }

  deleteLatex(notebook: LatexNotebook) {
    this.latexNotebooks.remove(this.bookId, notebook.id).subscribe({
      next: () => {
        this.latexList.update((list) => list.filter((n) => n.id !== notebook.id));
        if (this.activeLatex()?.id === notebook.id) {
          this.activeLatex.set(null);
          this.latexLastSaved = null;
          this.latexFocus.set(false);
          this.latexView.set('list');
          this.latexSaveStatus.set('idle');
        }
        this.scheduleReaderStateSave();
        this.notify.success('Caderno excluído');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir o caderno');
        this.latexError.set(message);
        this.notify.error(message);
      },
    });
  }

  private scheduleLatexAutosave() {
    if (!this.activeLatex()) return;
    this.latexSaveStatus.set('idle');
    if (this.latexAutoSaveTimer) clearTimeout(this.latexAutoSaveTimer);
    this.latexAutoSaveTimer = setTimeout(() => {
      this.latexAutoSaveTimer = null;
      this.flushLatexAutosave();
    }, LATEX_AUTOSAVE_MS);
  }

  private currentLatexPayload() {
    let content = this.latexContent();
    if (this.latexOpen() && this.latexView() === 'edit') {
      const fresh = this.latexEditor()?.getSource();
      if (fresh != null) content = fresh;
    }
    return {
      title: this.latexTitle().trim(),
      content,
      page: this.latexPage(),
      group_id: this.latexGroupId(),
    };
  }

  private flushLatexAutosave() {
    if (this.latexAutoSaveTimer) {
      clearTimeout(this.latexAutoSaveTimer);
      this.latexAutoSaveTimer = null;
    }
    const notebook = this.activeLatex();
    if (!notebook) return;
    if (this.latexSaving()) {
      this.latexSaveQueued = true;
      return;
    }

    const payload = this.currentLatexPayload();
    if (!payload.title) {
      this.latexSaveStatus.set('error');
      this.latexError.set('O título do caderno não pode ficar vazio');
      return;
    }
    if (
      this.latexLastSaved &&
      payload.title === this.latexLastSaved.title &&
      payload.content === this.latexLastSaved.content &&
      payload.page === this.latexLastSaved.page &&
      payload.group_id === this.latexLastSaved.group_id
    ) {
      this.latexSaveStatus.set('saved');
      return;
    }

    this.latexSaving.set(true);
    this.latexSaveStatus.set('saving');
    this.latexError.set(null);
    this.latexNotebooks.update(this.bookId, notebook.id, payload).subscribe({
      next: (saved) => {
        const queued = this.latexSaveQueued;
        const stillActive = this.activeLatex()?.id === saved.id;
        if (stillActive) {
          this.activeLatex.set(saved);
          if (!queued) this.latexContent.set(saved.content);
        }
        this.latexList.update((list) => [saved, ...list.filter((n) => n.id !== saved.id)]);
        if (stillActive) {
          this.latexLastSaved = {
            title: saved.title,
            content: saved.content,
            page: saved.page,
            group_id: saved.group_id,
          };
        }
        this.latexSaving.set(false);
        if (stillActive) this.latexSaveStatus.set('saved');
        this.scheduleReaderStateSave();
        if (queued && stillActive) {
          this.latexSaveQueued = false;
          this.scheduleLatexAutosave();
        } else if (queued) {
          this.latexSaveQueued = false;
        }
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível salvar o caderno');
        this.latexSaving.set(false);
        this.latexSaveStatus.set('error');
        this.latexError.set(message);
        this.notify.error(message);
      },
    });
  }

  // --- Word documents (ONLYOFFICE) -----------------------------------------
  toggleWord() {
    const open = !this.wordOpen();
    if (!open) {
      this.closeWordPanel();
      this.scheduleReaderStateSave();
      return;
    }

    this.wordOpen.set(true);
    this.panelOpen.set(false);
    this.diagramsOpen.set(false);
    this.notesOpen.set(false);
    this.closeSketchesPanel();
    this.closeLatexPanel();
    this.closeExercisesPanel();
    this.tocOpen.set(false);
    this.contentTreeOpen.set(false);
    this.closeTranslatePanel();
    this.wordError.set(null);
    if (!this.wordLoaded()) this.loadWord();
    this.scheduleReaderStateSave();
  }

  private loadWord(afterLoad?: () => void) {
    this.wordDocuments.list(this.bookId).subscribe({
      next: (documents) => {
        this.wordList.set(documents);
        this.wordLoaded.set(true);
        afterLoad?.();
      },
      error: (err) => {
        const message = this.errorText(err, 'Nao foi possivel carregar os documentos Word');
        this.wordError.set(message);
        this.notify.error(message);
      },
    });
  }

  private restoreWordState(state: ReaderState) {
    const wordState = state.word;
    const activeId = wordState?.view === 'edit' ? wordState.active_id : null;
    this.loadWord(() => {
      if (!this.wordOpen()) return;
      if (!activeId) {
        this.wordView.set('list');
        return;
      }
      const document = this.wordList().find((doc) => doc.id === activeId);
      if (document) {
        this.setActiveWord(document);
      } else {
        this.wordDocuments.get(this.bookId, activeId).subscribe({
          next: (item) => {
            if (!this.wordOpen()) return;
            this.wordList.update((list) => [item, ...list.filter((doc) => doc.id !== item.id)]);
            this.setActiveWord(item);
          },
          error: () => this.wordView.set('list'),
        });
      }
    });
  }

  newWord() {
    if (this.wordDetailsSaving()) return;
    this.wordDetailsSaving.set(true);
    this.wordEditorConfig.set(null);
    this.wordError.set(null);
    this.wordDocuments
      .create(this.bookId, {
        title: 'Documento sem titulo',
        page: this.currentDisplayPageValue(),
      })
      .subscribe({
        next: (saved) => {
          this.wordDetailsSaving.set(false);
          this.wordList.update((list) => [saved, ...list.filter((doc) => doc.id !== saved.id)]);
          this.setActiveWord(saved);
          this.scheduleReaderStateSave();
          this.notify.success('Documento Word criado');
        },
        error: (err) => {
          const message = this.errorText(err, 'Nao foi possivel criar o documento Word');
          this.wordDetailsSaving.set(false);
          this.wordError.set(message);
          this.notify.error(message);
        },
      });
  }

  openWord(document: WordDocument) {
    this.setActiveWord(document);
    this.scheduleReaderStateSave();
  }

  private setActiveWord(document: WordDocument) {
    this.activeWord.set(document);
    this.wordTitle.set(document.title);
    this.wordPage.set(document.page);
    this.wordError.set(null);
    this.wordView.set('edit');
    this.loadWordEditor(document);
  }

  private loadWordEditor(document: WordDocument) {
    this.wordEditorLoading.set(true);
    this.wordEditorConfig.set(null);
    this.wordDocuments.editorConfig(this.bookId, document.id).subscribe({
      next: (config) => {
        if (this.activeWord()?.id !== document.id) return;
        this.wordEditorConfig.set(config);
        this.wordEditorKey.update((value) => value + 1);
        this.wordEditorLoading.set(false);
      },
      error: (err) => {
        const message = this.errorText(err, 'Editor Word indisponivel');
        this.wordEditorLoading.set(false);
        this.wordError.set(message);
        this.notify.error(message);
      },
    });
  }

  backToWordList() {
    this.wordFocus.set(false);
    this.wordView.set('list');
    this.wordEditorConfig.set(null);
    this.loadWord();
    this.scheduleReaderStateSave();
  }

  setWordSearch(value: string) {
    this.wordSearch.set(value);
    this.scheduleReaderStateSave();
  }

  setWordTitle(value: string) {
    this.wordTitle.set(value);
  }

  setWordPage(value: number) {
    this.wordPage.set(value && value > 0 ? value : null);
  }

  saveWordDetails() {
    const document = this.activeWord();
    const title = this.wordTitle().trim();
    if (!document || !title || this.wordDetailsSaving()) return;
    this.wordDetailsSaving.set(true);
    this.wordDocuments
      .update(this.bookId, document.id, { title, page: this.wordPage() })
      .subscribe({
        next: (saved) => {
          this.activeWord.set(saved);
          this.wordTitle.set(saved.title);
          this.wordPage.set(saved.page);
          this.wordList.update((list) => [saved, ...list.filter((doc) => doc.id !== saved.id)]);
          this.wordDetailsSaving.set(false);
          this.scheduleReaderStateSave();
          this.notify.success('Documento Word salvo');
        },
        error: (err) => {
          const message = this.errorText(err, 'Nao foi possivel salvar o documento Word');
          this.wordDetailsSaving.set(false);
          this.wordError.set(message);
          this.notify.error(message);
        },
      });
  }

  downloadWord(document: WordDocument) {
    this.wordDocuments.download(this.bookId, document.id).subscribe({
      next: (blob) => {
        const win = this.document.defaultView;
        if (!win) return;
        const url = win.URL.createObjectURL(blob);
        const a = this.document.createElement('a');
        a.href = url;
        a.download = this.wordFilename(document);
        a.click();
        win.URL.revokeObjectURL(url);
      },
      error: (err) => {
        const message = this.errorText(err, 'Nao foi possivel baixar o documento Word');
        this.wordError.set(message);
        this.notify.error(message);
      },
    });
  }

  deleteWord(document: WordDocument) {
    const ok = window.confirm(`Excluir "${document.title}"?`);
    if (!ok) return;
    this.wordDocuments.remove(this.bookId, document.id).subscribe({
      next: () => {
        this.wordList.update((list) => list.filter((doc) => doc.id !== document.id));
        if (this.activeWord()?.id === document.id) {
          this.activeWord.set(null);
          this.wordEditorConfig.set(null);
          this.wordFocus.set(false);
          this.wordView.set('list');
        }
        this.scheduleReaderStateSave();
        this.notify.success('Documento Word excluido');
      },
      error: (err) => {
        const message = this.errorText(err, 'Nao foi possivel excluir o documento Word');
        this.wordError.set(message);
        this.notify.error(message);
      },
    });
  }

  toggleWordFocus() {
    this.wordFocus.update((value) => !value);
  }

  wordUpdatedLabel(document: WordDocument): string {
    return new Date(document.updated_at).toLocaleDateString('pt-BR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  wordFilename(document: WordDocument): string {
    const name = document.title.replace(/["\\\r\n]/g, '_').trim() || 'documento';
    return name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`;
  }

  onWordEditorError(message: string) {
    this.wordError.set(message);
  }

  onWordEditorWarning(message: string) {
    this.wordError.set(message);
  }

  // --- Study notes (Markdown) ----------------------------------------------
  // --- Exercise resolutions (cropped exercises) ----------------------------
  toggleCropMode() {
    if (this.loading() || this.error()) return;
    const next = !this.cropMode();
    this.cropMode.set(next);
    this.assistantCropMode.set(false);
    this.cropDraft.set(null);
    if (next) this.hideSelectionButton();
  }

  toggleExercises() {
    const open = !this.exercisesOpen();
    if (!open) {
      this.closeExercisesPanel();
      this.scheduleReaderStateSave();
      return;
    }
    this.openExercisesPanel();
    this.exercisesError.set(null);
    if (!this.exercisesLoaded()) this.loadExercises();
    this.scheduleReaderStateSave();
  }

  private openExercisesPanel() {
    this.exercisesOpen.set(true);
    this.panelOpen.set(false);
    this.diagramsOpen.set(false);
    this.notesOpen.set(false);
    this.closeSketchesPanel();
    this.closeLatexPanel();
    this.closeWordPanel();
    this.tocOpen.set(false);
    this.contentTreeOpen.set(false);
    this.closeTranslatePanel();
  }

  private closeExercisesPanel() {
    if (!this.exercisesOpen()) return;
    this.flushExerciseAutosave();
    this.exerciseFocus.set(false);
    this.attemptsOpen.set(false);
    this.exercisesOpen.set(false);
  }

  private loadExercises(afterLoad?: () => void) {
    this.exercises.list(this.bookId).subscribe({
      next: (items) => {
        this.exerciseList.set(items);
        this.exercisesLoaded.set(true);
        afterLoad?.();
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível carregar as resoluções');
        this.exercisesError.set(message);
        this.notify.error(message);
      },
    });
  }

  private restoreExercisesState(state: ReaderState) {
    const exState = state.exercises;
    const activeId = exState?.view === 'edit' ? exState.active_id : null;
    this.loadExercises(() => {
      if (!this.exercisesOpen()) return;
      if (!activeId) {
        this.exerciseView.set('list');
        return;
      }
      const found = this.exerciseList().find((e) => e.id === activeId);
      if (found) {
        this.setActiveExercise(found);
      } else {
        this.exercises.get(this.bookId, activeId).subscribe({
          next: (item) => {
            if (!this.exercisesOpen()) return;
            this.exerciseList.update((list) =>
              this.sortExercises([item, ...list.filter((e) => e.id !== item.id)]),
            );
            this.setActiveExercise(item);
          },
          error: () => this.exerciseView.set('list'),
        });
      }
    });
  }

  onRegionSelected(sel: AreaSelection) {
    if (this.assistantCropMode()) {
      this.assistantCropMode.set(false);
      this.pendingVisualSelection.set(sel);
      this.pendingSelection.set(null);
      this.selectionText.set('');
      if (!this.panelOpen()) {
        this.panelOpen.set(true);
        if (!this.historyLoaded) this.loadHistory();
        this.scheduleReaderStateSave();
      }
      return;
    }

    this.cropMode.set(false);
    this.cropDraft.set(sel);
    this.cropDraftTitle.set('Exercício');
    this.cropDraftStatement.set('');
    this.cropAnchorLeft.set(Math.max(8, Math.min(sel.anchor.x, window.innerWidth - 320)));
    this.cropAnchorTop.set(Math.max(8, Math.min(sel.anchor.y + 8, window.innerHeight - 200)));
    void this.extractRegionText(sel.page, sel.region).then((text) => {
      if (this.cropDraft() !== sel) return;
      this.cropDraftStatement.set(text);
      this.cropDraftTitle.set(this.suggestExerciseTitle(text));
    });
  }

  private async extractRegionText(page: number, region: ExerciseRegion): Promise<string> {
    const doc = this.pdfDoc;
    if (!doc) return '';
    try {
      const p = await doc.getPage(page);
      const viewport = p.getViewport({ scale: 1 });
      const content = await p.getTextContent();
      const x0 = region.x0 * viewport.width;
      const x1 = region.x1 * viewport.width;
      const y0 = region.y0 * viewport.height;
      const y1 = region.y1 * viewport.height;
      const parts: string[] = [];
      for (const item of content.items) {
        if (!this.isPdfTextItem(item)) continue;
        const t = item.transform;
        if (t.length < 6) continue;
        const x = Number(t[4]);
        // pdf.js text origins are bottom-left; flip to top-left viewport space.
        const y = viewport.height - Number(t[5]);
        if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 4 && item.str) {
          parts.push(item.str);
        }
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch {
      return '';
    }
  }

  private suggestExerciseTitle(text: string): string {
    const match = text.match(/exerc[íi]cio\s*[º°]?\s*[\dA-Za-z]+/i);
    if (match) {
      const label = match[0].replace(/\s+/g, ' ').trim();
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    const firstLine = (text.split(/[.;\n]/)[0] ?? '').trim();
    if (firstLine) return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
    return 'Exercício';
  }

  setCropTitle(value: string) {
    this.cropDraftTitle.set(value);
  }

  cancelCrop() {
    this.cropDraft.set(null);
  }

  confirmCrop() {
    const draft = this.cropDraft();
    if (!draft) return;
    const title = this.cropDraftTitle().trim() || 'Exercício';
    const statement = this.cropDraftStatement();
    this.cropDraft.set(null);
    this.exercisesError.set(null);
    this.exercises
      .create(this.bookId, { title, page: draft.page, region: draft.region, statement })
      .subscribe({
        next: (saved) => {
          this.exerciseList.update((list) => this.sortExercises([saved, ...list]));
          this.exercisesLoaded.set(true);
          this.openExercisesPanel();
          this.setActiveExercise(saved);
          this.scheduleReaderStateSave();
          this.notify.success('Resolução criada');
        },
        error: (err) => {
          const message = this.errorText(err, 'Não foi possível criar a resolução');
          this.exercisesError.set(message);
          this.notify.error(message);
        },
      });
  }

  openExercise(res: ExerciseResolution) {
    if (this.activeExercise()?.id !== res.id) this.flushExerciseAutosave();
    this.setActiveExercise(res);
    this.scheduleReaderStateSave();
  }

  private setActiveExercise(res: ExerciseResolution) {
    this.activeExercise.set(res);
    this.exerciseTitle.set(res.title);
    this.exerciseStatement.set(res.statement);
    this.editingStatement.set(false);
    this.resetHintLevels();
    this.exerciseLatex.set(res.latex_content);
    this.exerciseSketch.set(res.sketch_content);
    this.exerciseStatus.set(res.status);
    this.exerciseTab.set('latex');
    this.attemptsOpen.set(false);
    this.exerciseAiText.set('');
    this.exerciseAiMode.set(null);
    this.exerciseAiError.set(null);
    this.askInput.set('');
    this.resetChat();
    this.loadChat(res.id);
    this.exerciseLastSaved = {
      title: res.title,
      statement: res.statement,
      latex_content: res.latex_content,
      sketch_content: res.sketch_content,
    };
    this.exerciseSaveStatus.set('saved');
    this.exercisesError.set(null);
    this.bumpExerciseEpoch();
    this.exerciseView.set('edit');
  }

  backToExerciseList() {
    this.flushExerciseAutosave();
    this.exerciseFocus.set(false);
    this.attemptsOpen.set(false);
    this.exerciseView.set('list');
    this.scheduleReaderStateSave();
  }

  setExerciseSearch(value: string) {
    this.exerciseSearch.set(value);
    this.scheduleReaderStateSave();
  }

  setExerciseTitle(value: string) {
    this.exerciseTitle.set(value);
    this.scheduleExerciseAutosave();
  }

  setExerciseStatement(value: string) {
    this.exerciseStatement.set(value);
    this.scheduleExerciseAutosave();
  }

  toggleStatementEdit() {
    this.editingStatement.update((v) => !v);
  }

  setExerciseTab(tab: 'latex' | 'sketch') {
    if (this.exerciseTab() === tab) return;
    this.pullExerciseContent();
    this.exerciseTab.set(tab);
  }

  onExerciseLatexChange(source: string) {
    this.exerciseLatex.set(source);
    this.scheduleExerciseAutosave();
  }

  onExerciseSketchChange(scene: string) {
    this.exerciseSketch.set(scene);
    this.scheduleExerciseAutosave();
  }

  setExerciseStatus(status: ExerciseStatus) {
    const res = this.activeExercise();
    if (!res) return;
    this.exerciseStatus.set(status);
    this.exercises.update(this.bookId, res.id, { status }).subscribe({
      next: (saved) => this.applySavedExercise(saved),
      error: (err) => this.notify.error(this.errorText(err, 'Não foi possível salvar o status')),
    });
  }

  toggleExerciseFocus() {
    this.exerciseFocus.update((v) => !v);
  }

  exerciseUpdatedLabel(res: ExerciseResolution): string {
    return new Date(res.updated_at).toLocaleDateString('pt-BR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  attemptLabel(attempt: ExerciseAttempt): string {
    return new Date(attempt.created_at).toLocaleString('pt-BR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  deleteExercise(res: ExerciseResolution) {
    const ok = window.confirm(`Excluir "${res.title}"?`);
    if (!ok) return;
    this.exercises.remove(this.bookId, res.id).subscribe({
      next: () => {
        this.exerciseList.update((list) => list.filter((e) => e.id !== res.id));
        if (this.activeExercise()?.id === res.id) {
          this.activeExercise.set(null);
          this.exerciseLastSaved = null;
          this.exerciseFocus.set(false);
          this.attemptsOpen.set(false);
          this.exerciseView.set('list');
          this.exerciseSaveStatus.set('idle');
        }
        this.scheduleReaderStateSave();
        this.notify.success('Resolução excluída');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir a resolução');
        this.exercisesError.set(message);
        this.notify.error(message);
      },
    });
  }

  private bumpExerciseEpoch() {
    this.exerciseEpoch.update((v) => v + 1);
  }

  toggleAttempts() {
    const res = this.activeExercise();
    if (!res) return;
    const open = !this.attemptsOpen();
    this.attemptsOpen.set(open);
    if (!open) return;
    this.attemptsLoading.set(true);
    this.exercises.listAttempts(this.bookId, res.id).subscribe({
      next: (list) => {
        this.attemptList.set(list);
        this.attemptsLoading.set(false);
      },
      error: (err) => {
        this.attemptsLoading.set(false);
        this.notify.error(this.errorText(err, 'Não foi possível carregar as tentativas'));
      },
    });
  }

  newAttempt() {
    const res = this.activeExercise();
    if (!res || this.exerciseSaving()) return;
    const content = this.pullExerciseContent();
    this.exerciseSaving.set(true);
    this.exerciseSaveStatus.set('saving');
    this.exercises.update(this.bookId, res.id, content).subscribe({
      next: (saved) => {
        this.applySavedExercise(saved);
        this.exercises.createAttempt(this.bookId, res.id).subscribe({
          next: (attempt) => {
            this.attemptList.update((list) => [attempt, ...list]);
            this.exercises
              .update(this.bookId, res.id, { latex_content: '', sketch_content: '' })
              .subscribe({
                next: (cleared) => {
                  this.applySavedExercise(cleared);
                  this.exerciseLatex.set('');
                  this.exerciseSketch.set('');
                  this.exerciseTab.set('latex');
                  this.exerciseAiText.set('');
                  this.bumpExerciseEpoch();
                  this.exerciseSaving.set(false);
                  this.exerciseSaveStatus.set('saved');
                  this.notify.success('Nova tentativa iniciada');
                },
                error: (err) => {
                  this.exerciseSaving.set(false);
                  this.notify.error(this.errorText(err, 'Não foi possível limpar a resolução'));
                },
              });
          },
          error: (err) => {
            this.exerciseSaving.set(false);
            this.notify.error(this.errorText(err, 'Não foi possível criar a tentativa'));
          },
        });
      },
      error: (err) => {
        this.exerciseSaving.set(false);
        this.exerciseSaveStatus.set('error');
        this.notify.error(this.errorText(err, 'Não foi possível salvar a resolução'));
      },
    });
  }

  restoreAttempt(attempt: ExerciseAttempt) {
    const res = this.activeExercise();
    if (!res || this.exerciseSaving()) return;
    const content = this.pullExerciseContent();
    this.exerciseSaving.set(true);
    this.exerciseSaveStatus.set('saving');
    this.exercises.update(this.bookId, res.id, content).subscribe({
      next: (saved) => {
        this.applySavedExercise(saved);
        this.exercises.createAttempt(this.bookId, res.id).subscribe({
          next: (snap) => {
            this.attemptList.update((list) => [snap, ...list]);
            this.exercises
              .update(this.bookId, res.id, {
                latex_content: attempt.latex_content,
                sketch_content: attempt.sketch_content,
              })
              .subscribe({
                next: (restored) => {
                  this.applySavedExercise(restored);
                  this.exerciseLatex.set(restored.latex_content);
                  this.exerciseSketch.set(restored.sketch_content);
                  this.exerciseTab.set('latex');
                  this.attemptsOpen.set(false);
                  this.bumpExerciseEpoch();
                  this.exerciseSaving.set(false);
                  this.exerciseSaveStatus.set('saved');
                  this.notify.success('Tentativa restaurada');
                },
                error: (err) => {
                  this.exerciseSaving.set(false);
                  this.notify.error(this.errorText(err, 'Não foi possível restaurar'));
                },
              });
          },
          error: (err) => {
            this.exerciseSaving.set(false);
            this.notify.error(this.errorText(err, 'Não foi possível criar a tentativa'));
          },
        });
      },
      error: (err) => {
        this.exerciseSaving.set(false);
        this.exerciseSaveStatus.set('error');
        this.notify.error(this.errorText(err, 'Não foi possível salvar a resolução'));
      },
    });
  }

  askExerciseAI(mode: ExerciseAIMode) {
    const res = this.activeExercise();
    if (!res || this.exerciseAiBusy()) return;
    const content = this.pullExerciseContent();
    this.exerciseAiBusy.set(true);
    this.exerciseAiMode.set(mode);
    this.exerciseAiError.set(null);
    this.exerciseAiText.set('');
    // Persist the latest work first so the server-side AI reads the current state.
    this.exercises.update(this.bookId, res.id, content).subscribe({
      next: (saved) => {
        this.applySavedExercise(saved);
        if (mode === 'statement') {
          this.exerciseStatement.set('');
          this.editingStatement.set(false);
        }
        this.streamExerciseAI(res.id, mode);
      },
      error: (err) => {
        this.exerciseAiBusy.set(false);
        const message = this.errorText(err, 'Não foi possível preparar a IA');
        this.exerciseAiError.set(message);
        this.notify.error(message);
      },
    });
  }

  private streamExerciseAI(id: number, mode: ExerciseAIMode) {
    this.exerciseAiController?.abort();
    const controller = new AbortController();
    this.exerciseAiController = controller;
    void this.exercises.askAI(
      this.bookId,
      id,
      { mode },
      {
        onDelta: (text) => {
          if (mode === 'statement') this.exerciseStatement.update((t) => t + text);
          else this.exerciseAiText.update((t) => t + text);
        },
        onDone: (data) => {
          this.exerciseAiBusy.set(false);
          if (mode === 'statement') {
            this.scheduleExerciseAutosave();
          } else if (mode === 'review' && data.content && this.activeExercise()?.id === id) {
            this.exercises.update(this.bookId, id, { ai_feedback: data.content }).subscribe({
              next: (saved) => this.applySavedExercise(saved),
              error: () => {},
            });
          }
        },
        onError: (message) => {
          this.exerciseAiBusy.set(false);
          this.exerciseAiError.set(message);
          this.notify.error(message);
        },
      },
      controller.signal,
    );
  }

  requestHintLevel() {
    const res = this.activeExercise();
    if (!res || this.hintBusy()) return;
    const level = this.hintLevels().length + 1;
    if (level > 3) return;
    const content = this.pullExerciseContent();
    this.hintBusy.set(true);
    this.hintError.set(null);
    this.hintStreaming.set('');
    // Persist current work/statement first so the AI reads the latest state.
    this.exercises.update(this.bookId, res.id, content).subscribe({
      next: (saved) => {
        this.applySavedExercise(saved);
        this.streamHintLevel(res.id, level);
      },
      error: (err) => {
        this.hintBusy.set(false);
        const message = this.errorText(err, 'Não foi possível preparar a dica');
        this.hintError.set(message);
        this.notify.error(message);
      },
    });
  }

  private streamHintLevel(id: number, level: number) {
    this.hintController?.abort();
    const controller = new AbortController();
    this.hintController = controller;
    void this.exercises.askAI(
      this.bookId,
      id,
      { mode: 'hint_level', level },
      {
        onDelta: (text) => this.hintStreaming.update((t) => t + text),
        onDone: () => {
          const text = this.hintStreaming().trim();
          if (text) this.hintLevels.update((list) => [...list, { level, text }]);
          this.hintStreaming.set('');
          this.hintBusy.set(false);
        },
        onError: (message) => {
          this.hintBusy.set(false);
          this.hintError.set(message);
          this.notify.error(message);
        },
      },
      controller.signal,
    );
  }

  private resetHintLevels() {
    this.hintController?.abort();
    this.hintLevels.set([]);
    this.hintStreaming.set('');
    this.hintBusy.set(false);
    this.hintError.set(null);
  }

  sendChat() {
    const res = this.activeExercise();
    const question = this.askInput().trim();
    if (!res || this.chatBusy() || !question) return;
    const content = this.pullExerciseContent();
    this.askInput.set('');
    this.chatError.set(null);
    this.chatStreaming.set('');
    this.chatBusy.set(true);
    // Optimistic user bubble; the server persists both turns.
    this.chatMessages.update((list) => [
      ...list,
      { id: -1, role: 'user', content: question, created_at: '' },
    ]);
    // Persist current work first so the AI reads the latest state, then stream.
    this.exercises.update(this.bookId, res.id, content).subscribe({
      next: (saved) => {
        this.applySavedExercise(saved);
        this.streamChat(res.id, question);
      },
      error: (err) => {
        this.chatBusy.set(false);
        const message = this.errorText(err, 'Não foi possível enviar a pergunta');
        this.chatError.set(message);
        this.notify.error(message);
      },
    });
  }

  private streamChat(id: number, question: string) {
    this.chatController?.abort();
    const controller = new AbortController();
    this.chatController = controller;
    void this.exercises.chat(
      this.bookId,
      id,
      { question },
      {
        onDelta: (text) => this.chatStreaming.update((t) => t + text),
        onDone: () => {
          this.chatStreaming.set('');
          this.chatBusy.set(false);
          this.loadChat(id);
        },
        onError: (message) => {
          this.chatBusy.set(false);
          this.chatError.set(message);
          this.notify.error(message);
        },
      },
      controller.signal,
    );
  }

  private loadChat(id: number) {
    this.exercises.listChat(this.bookId, id).subscribe({
      next: (messages) => {
        if (this.activeExercise()?.id === id) this.chatMessages.set(messages);
      },
      error: () => {},
    });
  }

  clearChat() {
    const res = this.activeExercise();
    if (!res || this.chatBusy()) return;
    this.exercises.clearChat(this.bookId, res.id).subscribe({
      next: () => {
        this.chatMessages.set([]);
        this.chatStreaming.set('');
        this.chatError.set(null);
      },
      error: (err) =>
        this.notify.error(this.errorText(err, 'Não foi possível limpar a conversa')),
    });
  }

  private resetChat() {
    this.chatController?.abort();
    this.chatMessages.set([]);
    this.chatStreaming.set('');
    this.chatBusy.set(false);
    this.chatError.set(null);
  }

  private applySavedExercise(saved: ExerciseResolution) {
    const stillActive = this.activeExercise()?.id === saved.id;
    if (stillActive) {
      this.activeExercise.set(saved);
      this.exerciseStatus.set(saved.status);
      this.exerciseLastSaved = {
        title: saved.title,
        statement: saved.statement,
        latex_content: saved.latex_content,
        sketch_content: saved.sketch_content,
      };
    }
    this.exerciseList.update((list) =>
      this.sortExercises(list.map((e) => (e.id === saved.id ? saved : e))),
    );
  }

  private sortExercises(list: ExerciseResolution[]): ExerciseResolution[] {
    return [...list].sort((a, b) => a.page - b.page || b.id - a.id);
  }

  private currentExercisePayload() {
    let latex = this.exerciseLatex();
    let sketch = this.exerciseSketch();
    if (this.exercisesOpen() && this.exerciseView() === 'edit') {
      const freshLatex = this.exerciseLatexEditor()?.getSource();
      if (freshLatex != null) latex = freshLatex;
      const freshSketch = this.exerciseSketchCanvas()?.getScene();
      if (freshSketch != null) sketch = freshSketch;
    }
    return {
      title: this.exerciseTitle().trim(),
      statement: this.exerciseStatement(),
      latex_content: latex,
      sketch_content: sketch,
    };
  }

  private pullExerciseContent(): {
    statement: string;
    latex_content: string;
    sketch_content: string;
  } {
    const payload = this.currentExercisePayload();
    this.exerciseLatex.set(payload.latex_content);
    this.exerciseSketch.set(payload.sketch_content);
    return {
      statement: payload.statement,
      latex_content: payload.latex_content,
      sketch_content: payload.sketch_content,
    };
  }

  private scheduleExerciseAutosave() {
    if (!this.activeExercise()) return;
    this.exerciseSaveStatus.set('idle');
    if (this.exerciseAutoSaveTimer) clearTimeout(this.exerciseAutoSaveTimer);
    this.exerciseAutoSaveTimer = setTimeout(() => {
      this.exerciseAutoSaveTimer = null;
      this.flushExerciseAutosave();
    }, EXERCISE_AUTOSAVE_MS);
  }

  private flushExerciseAutosave() {
    if (this.exerciseAutoSaveTimer) {
      clearTimeout(this.exerciseAutoSaveTimer);
      this.exerciseAutoSaveTimer = null;
    }
    const res = this.activeExercise();
    if (!res) return;
    if (this.exerciseSaving()) {
      this.exerciseSaveQueued = true;
      return;
    }
    const payload = this.currentExercisePayload();
    if (!payload.title) {
      this.exerciseSaveStatus.set('error');
      this.exercisesError.set('O título não pode ficar vazio');
      return;
    }
    if (
      this.exerciseLastSaved &&
      payload.title === this.exerciseLastSaved.title &&
      payload.statement === this.exerciseLastSaved.statement &&
      payload.latex_content === this.exerciseLastSaved.latex_content &&
      payload.sketch_content === this.exerciseLastSaved.sketch_content
    ) {
      this.exerciseSaveStatus.set('saved');
      return;
    }
    this.exerciseSaving.set(true);
    this.exerciseSaveStatus.set('saving');
    this.exercisesError.set(null);
    this.exercises.update(this.bookId, res.id, payload).subscribe({
      next: (saved) => {
        const queued = this.exerciseSaveQueued;
        const stillActive = this.activeExercise()?.id === saved.id;
        if (stillActive) {
          this.activeExercise.set(saved);
          if (!queued) {
            this.exerciseLatex.set(saved.latex_content);
            this.exerciseSketch.set(saved.sketch_content);
          }
        }
        this.exerciseList.update((list) =>
          this.sortExercises(list.map((e) => (e.id === saved.id ? saved : e))),
        );
        if (stillActive) {
          this.exerciseLastSaved = {
            title: saved.title,
            statement: saved.statement,
            latex_content: saved.latex_content,
            sketch_content: saved.sketch_content,
          };
        }
        this.exerciseSaving.set(false);
        if (stillActive) this.exerciseSaveStatus.set('saved');
        this.scheduleReaderStateSave();
        if (queued && stillActive) {
          this.exerciseSaveQueued = false;
          this.scheduleExerciseAutosave();
        } else if (queued) {
          this.exerciseSaveQueued = false;
        }
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível salvar a resolução');
        this.exerciseSaving.set(false);
        this.exerciseSaveStatus.set('error');
        this.exercisesError.set(message);
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
      this.closeLatexPanel();
      this.closeWordPanel();
      this.closeExercisesPanel();
      this.tocOpen.set(false);
      this.contentTreeOpen.set(false);
      this.closeTranslatePanel();
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
        const message = this.errorText(err, 'Não foi possível carregar as notas');
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
    this.noteTitle.set('Nota sem título');
    this.noteContent.set('');
    this.notePage.set(this.currentDisplayPageValue());
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
    return new Date(note.updated_at).toLocaleDateString('pt-BR', {
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
        this.notify.success('Nota salva');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível salvar a nota');
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
        this.notify.success('Nota excluída');
      },
      error: (err) => {
        const message = this.errorText(err, 'Não foi possível excluir a nota');
        this.notesError.set(message);
        this.notify.error(message);
      },
    });
  }
}
