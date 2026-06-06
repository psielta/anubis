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

@Component({
  selector: 'app-reader',
  imports: [RouterLink, MatButtonModule, MatIconModule],
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

  private data: ArrayBuffer | null = null;
  private initialized = false;

  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pdfDoc: PDFDocumentProxy | null = null;
  private scaleBase = 1; // page scale that renders at 100%
  private observer: IntersectionObserver | null = null;
  private pages: PdfPage[] = [];

  ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.fail('Invalid book');
      return;
    }
    this.library.get(id).subscribe({
      next: (book) => {
        this.book.set(book);
        if (book.file_format !== 'pdf') {
          this.fail('This book format cannot be read in the app');
          return;
        }
        this.loadFile(id);
      },
      error: () => this.fail('Book not found'),
    });
  }

  ngOnDestroy() {
    this.observer?.disconnect();
    this.loadingTask?.destroy();
  }

  ngAfterViewInit() {
    this.tryInit();
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
    } catch {
      this.error.set('Could not render this PDF');
    }
  }

  private async buildPages(el: HTMLElement) {
    if (!this.pdfDoc) return;
    this.observer?.disconnect();
    el.replaceChildren();
    this.pages = [];

    const scale = this.scaleBase * (this.zoomPct() / 100);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const num = Number((entry.target as HTMLElement).dataset['page']);
          if (entry.isIntersecting) {
            void this.renderPage(num, scale);
            this.currentPage.set(num);
          }
        }
      },
      { root: el, rootMargin: '300px 0px', threshold: 0.05 },
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
    if (el) void this.buildPages(el);
  }
}
