import { UpperCasePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { LibraryService } from '../../core/services/library';
import { Book } from '../../core/models/book.model';
import { Collection } from '../../core/models/collection.model';

const MAX_UPLOAD_MB = 250;
const MAX_COVER_MB = 5;
const ACCEPTED_EXTENSIONS = ['.pdf'];
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-library',
  imports: [
    UpperCasePipe,
    ReactiveFormsModule,
    RouterLink,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatProgressBarModule,
    MatIconModule,
    MatMenuModule,
    MatPaginatorModule,
  ],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private library = inject(LibraryService);
  private sanitizer = inject(DomSanitizer);

  protected readonly books = signal<Book[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(0); // 0-based, for the paginator
  protected readonly pageSize = signal(12);
  protected readonly search = signal('');
  protected readonly activeCollectionId = signal<number | null>(null);
  protected readonly collections = signal<Collection[]>([]);
  protected readonly creatingCollection = signal(false);
  protected readonly editingCollectionId = signal<number | null>(null);

  protected readonly loading = signal(false);
  protected readonly uploading = signal(false);
  protected readonly progress = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedFile = signal<File | null>(null);
  protected readonly selectedCover = signal<File | null>(null);
  protected readonly coverPreview = signal<SafeUrl | null>(null);

  protected readonly coverUrls = signal<Record<number, SafeUrl>>({});
  private coverRawUrls: Record<number, string> = {};
  private coverPreviewRaw: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(512)]],
    author: ['', [Validators.maxLength(255)]],
  });

  ngOnInit() {
    this.loadCollections();
    this.load();
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    for (const url of Object.values(this.coverRawUrls)) URL.revokeObjectURL(url);
    if (this.coverPreviewRaw) URL.revokeObjectURL(this.coverPreviewRaw);
  }

  private load() {
    this.loading.set(true);
    this.error.set(null);
    this.library
      .list({
        search: this.search() || undefined,
        collectionId: this.activeCollectionId(),
        page: this.page() + 1,
        pageSize: this.pageSize(),
      })
      .subscribe({
        next: (result) => {
          this.books.set(result.items);
          this.total.set(result.total);
          this.loading.set(false);
          this.refreshCovers(result.items);
        },
        error: (e) => {
          this.error.set(e?.error?.detail ?? 'Failed to load library');
          this.loading.set(false);
        },
      });
  }

  private loadCollections() {
    this.library.listCollections().subscribe({
      next: (collections) => this.collections.set(collections),
      error: () => {},
    });
  }

  onSearch(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(0);
      this.load();
    }, SEARCH_DEBOUNCE_MS);
  }

  filterBy(collectionId: number | null) {
    this.activeCollectionId.set(collectionId);
    this.page.set(0);
    this.load();
  }

  onPage(event: PageEvent) {
    this.page.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
    this.load();
  }

  startCreateCollection() {
    this.creatingCollection.set(true);
  }

  createCollection(name: string) {
    const trimmed = name.trim();
    this.creatingCollection.set(false);
    if (!trimmed) return;
    this.library.createCollection(trimmed).subscribe({
      next: () => this.loadCollections(),
      error: (e) => this.error.set(e?.error?.detail ?? 'Could not create collection'),
    });
  }

  startRename(collection: Collection, event: Event) {
    event.stopPropagation();
    this.editingCollectionId.set(collection.id);
  }

  renameCollection(collection: Collection, name: string) {
    const trimmed = name.trim();
    this.editingCollectionId.set(null);
    if (!trimmed || trimmed === collection.name) return;
    this.library.renameCollection(collection.id, trimmed).subscribe({
      next: () => this.loadCollections(),
      error: (e) => this.error.set(e?.error?.detail ?? 'Could not rename collection'),
    });
  }

  deleteCollection(collection: Collection, event: Event) {
    event.stopPropagation();
    this.library.deleteCollection(collection.id).subscribe({
      next: () => {
        if (this.activeCollectionId() === collection.id) {
          this.activeCollectionId.set(null);
          this.page.set(0);
          this.load();
        }
        this.loadCollections();
      },
      error: (e) => this.error.set(e?.error?.detail ?? 'Could not delete collection'),
    });
  }

  toggleBookCollection(book: Book, collectionId: number, event: Event) {
    event.stopPropagation();
    const ids = book.collection_ids.includes(collectionId)
      ? book.collection_ids.filter((id) => id !== collectionId)
      : [...book.collection_ids, collectionId];
    this.library.setBookCollections(book.id, ids).subscribe({
      next: (updated) => {
        this.books.update((list) => list.map((b) => (b.id === book.id ? updated : b)));
        this.loadCollections();
      },
      error: (e) => this.error.set(e?.error?.detail ?? 'Could not update collections'),
    });
  }

  /** Collections a book belongs to (for the chips shown on its card). */
  collectionsFor(book: Book): Collection[] {
    return this.collections().filter((c) => book.collection_ids.includes(c.id));
  }

  private refreshCovers(books: Book[]) {
    for (const url of Object.values(this.coverRawUrls)) URL.revokeObjectURL(url);
    this.coverRawUrls = {};
    this.coverUrls.set({});
    for (const book of books) {
      if (book.has_cover) this.loadCover(book.id);
    }
  }

  private loadCover(id: number) {
    this.library.getCover(id).subscribe({
      next: (blob) => {
        const raw = URL.createObjectURL(blob);
        const prev = this.coverRawUrls[id];
        if (prev) URL.revokeObjectURL(prev);
        this.coverRawUrls[id] = raw;
        this.coverUrls.update((m) => ({
          ...m,
          [id]: this.sanitizer.bypassSecurityTrustUrl(raw),
        }));
      },
      error: () => {},
    });
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.error.set(null);

    if (!file) {
      this.selectedFile.set(null);
      return;
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      this.error.set('Only PDF files are supported');
      this.selectedFile.set(null);
      input.value = '';
      return;
    }

    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      this.error.set(`File exceeds ${MAX_UPLOAD_MB} MB limit`);
      this.selectedFile.set(null);
      input.value = '';
      return;
    }

    this.selectedFile.set(file);
  }

  onCoverSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    if (!this.validateImage(file, input)) return;

    this.selectedCover.set(file);
    if (this.coverPreviewRaw) URL.revokeObjectURL(this.coverPreviewRaw);
    this.coverPreviewRaw = URL.createObjectURL(file);
    this.coverPreview.set(this.sanitizer.bypassSecurityTrustUrl(this.coverPreviewRaw));
  }

  clearCover() {
    this.selectedCover.set(null);
    if (this.coverPreviewRaw) URL.revokeObjectURL(this.coverPreviewRaw);
    this.coverPreviewRaw = null;
    this.coverPreview.set(null);
  }

  private validateImage(file: File, input: HTMLInputElement): boolean {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      this.error.set('Cover must be a PNG, JPEG or WebP image');
      input.value = '';
      return false;
    }
    if (file.size > MAX_COVER_MB * 1024 * 1024) {
      this.error.set(`Cover exceeds ${MAX_COVER_MB} MB limit`);
      input.value = '';
      return false;
    }
    this.error.set(null);
    return true;
  }

  import() {
    const file = this.selectedFile();
    if (!file || this.form.invalid) return;

    const { title, author } = this.form.getRawValue();
    this.uploading.set(true);
    this.progress.set(0);
    this.error.set(null);

    this.library.import(title, author || null, file, this.selectedCover()).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress && event.total) {
          this.progress.set(Math.round((100 * event.loaded) / event.total));
        }
        if (event.type === HttpEventType.Response) {
          this.form.reset();
          this.selectedFile.set(null);
          this.clearCover();
          this.uploading.set(false);
          this.progress.set(0);
          // Show the newest book at the top of the first page.
          this.search.set('');
          this.activeCollectionId.set(null);
          this.page.set(0);
          this.load();
        }
      },
      error: (e) => {
        this.error.set(e?.error?.detail ?? 'Import failed');
        this.uploading.set(false);
        this.progress.set(0);
      },
    });
  }

  changeCover(book: Book, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file || !this.validateImage(file, input)) return;

    this.library.uploadCover(book.id, file).subscribe({
      next: (updated) => {
        this.books.update((books) => books.map((b) => (b.id === book.id ? updated : b)));
        this.loadCover(book.id);
      },
      error: (e) => this.error.set(e?.error?.detail ?? 'Cover upload failed'),
    });
    input.value = '';
  }

  download(book: Book) {
    this.library.download(book.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = book.original_filename;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: (e) => this.error.set(e?.error?.detail ?? 'Download failed'),
    });
  }

  remove(book: Book) {
    this.library.remove(book.id).subscribe({
      next: () => {
        const raw = this.coverRawUrls[book.id];
        if (raw) {
          URL.revokeObjectURL(raw);
          delete this.coverRawUrls[book.id];
        }
        // Step back a page if we just emptied the last one.
        if (this.books().length === 1 && this.page() > 0) {
          this.page.update((p) => p - 1);
        }
        this.load();
        this.loadCollections();
      },
      error: (e) => this.error.set(e?.error?.detail ?? 'Delete failed'),
    });
  }

  /** First two significant letters of a title, for the cover-spine stand-in. */
  initials(title: string): string {
    const words = title.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '·';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  /** Human-readable file size. */
  sizeLabel(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** Reading progress percent (1-100), or null if the book hasn't been opened. */
  readingProgress(book: Book): number | null {
    if (!book.last_page || !book.page_count) return null;
    return Math.min(100, Math.max(1, Math.round((100 * book.last_page) / book.page_count)));
  }
}
