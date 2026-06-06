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
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { LibraryService } from '../../core/services/library';
import { Book } from '../../core/models/book.model';

// Resolve the pdf.js worker through the bundler (Angular's esbuild builder
// emits it as an asset and rewrites this URL).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

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
  imports: [RouterLink, MatButtonModule, MatIconModule, MatMenuModule],
  templateUrl: './reader.html',
  styleUrl: './reader.scss',
})
export class Reader implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private library = inject(LibraryService);

  private viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');

  protected readonly book = signal<Book | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly pageCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly zoomPct = signal(100);
  protected readonly toc = signal<TocItem[]>([]);

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
    } catch {
      entry.rendered = false;
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
}
