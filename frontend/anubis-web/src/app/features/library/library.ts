import { UpperCasePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { Book, BookSort, BookStatus } from '../../core/models/book.model';
import { Collection } from '../../core/models/collection.model';
import { LibraryService } from '../../core/services/library';
import { NotificationsService } from '../../core/services/notifications';
import { EditBookDialog } from './edit-book-dialog/edit-book-dialog';
import { UploadDialog } from './upload-dialog/upload-dialog';

const MAX_COVER_MB = 5;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const SEARCH_DEBOUNCE_MS = 300;

type ViewMode = 'grid' | 'list';

@Component({
  selector: 'app-library',
  imports: [
    UpperCasePipe,
    RouterLink,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatPaginatorModule,
  ],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library implements OnInit, OnDestroy {
  private library = inject(LibraryService);
  private sanitizer = inject(DomSanitizer);
  private dialog = inject(MatDialog);
  private notify = inject(NotificationsService);

  protected readonly statuses: { value: BookStatus; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'favorites', label: 'Favorites' },
    { value: 'plan_to_read', label: 'Plan to Read' },
    { value: 'completed', label: 'Completed' },
  ];

  protected readonly books = signal<Book[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly pageSize = signal(24);
  protected readonly search = signal('');
  protected readonly status = signal<BookStatus>('all');
  protected readonly sort = signal<BookSort>('date');
  protected readonly viewMode = signal<ViewMode>('grid');
  protected readonly collections = signal<Collection[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly coverUrls = signal<Record<number, SafeUrl>>({});

  private coverRawUrls: Record<number, string> = {};
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    this.loadCollections();
    this.load();
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    for (const url of Object.values(this.coverRawUrls)) URL.revokeObjectURL(url);
  }

  protected onSearch(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(0);
      this.load();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected setStatus(status: BookStatus) {
    if (this.status() === status) return;
    this.status.set(status);
    this.page.set(0);
    this.load();
  }

  protected setSort(sort: BookSort) {
    if (this.sort() === sort) return;
    this.sort.set(sort);
    this.page.set(0);
    this.load();
  }

  protected setViewMode(mode: ViewMode) {
    this.viewMode.set(mode);
  }

  protected onPage(event: PageEvent) {
    this.page.set(event.pageIndex);
    this.pageSize.set(event.pageSize);
    this.load();
  }

  protected openUpload() {
    const ref = this.dialog.open(UploadDialog, {
      panelClass: 'anubis-dialog',
      width: '520px',
      autoFocus: false,
    });
    ref.afterClosed().subscribe((didUpload: boolean | undefined) => {
      if (!didUpload) return;
      this.search.set('');
      this.status.set('all');
      this.sort.set('date');
      this.page.set(0);
      this.load();
      this.loadCollections();
    });
  }

  protected openEdit(book: Book) {
    const ref = this.dialog.open(EditBookDialog, {
      panelClass: 'anubis-dialog',
      width: '440px',
      data: { book },
      autoFocus: false,
    });
    ref.afterClosed().subscribe((updated: Book | undefined) => {
      if (updated) this.patchBook(updated);
    });
  }

  protected toggleFavorite(book: Book, event: Event) {
    event.stopPropagation();
    this.library.update(book.id, { is_favorite: !book.is_favorite }).subscribe({
      next: (updated) => this.patchBook(updated),
      error: (e) => this.reportError(e, 'Could not update favorite'),
    });
  }

  protected toggleBookCollection(book: Book, collectionId: number, event: Event) {
    event.stopPropagation();
    const ids = book.collection_ids.includes(collectionId)
      ? book.collection_ids.filter((id) => id !== collectionId)
      : [...book.collection_ids, collectionId];
    this.library.setBookCollections(book.id, ids).subscribe({
      next: (updated) => {
        this.patchBook(updated);
        this.loadCollections();
      },
      error: (e) => this.reportError(e, 'Could not update series'),
    });
  }

  protected changeCover(book: Book, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file || !this.validateImage(file, input)) return;

    this.library.uploadCover(book.id, file).subscribe({
      next: (updated) => {
        this.patchBook(updated);
        this.loadCover(book.id);
        this.notify.success('Cover updated');
      },
      error: (e) => this.reportError(e, 'Cover upload failed'),
    });
    input.value = '';
  }

  protected download(book: Book) {
    this.library.download(book.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = book.original_filename;
        anchor.click();
        URL.revokeObjectURL(url);
      },
      error: (e) => this.reportError(e, 'Download failed'),
    });
  }

  protected remove(book: Book) {
    this.library.remove(book.id).subscribe({
      next: () => {
        const raw = this.coverRawUrls[book.id];
        if (raw) {
          URL.revokeObjectURL(raw);
          delete this.coverRawUrls[book.id];
        }
        if (this.books().length === 1 && this.page() > 0) {
          this.page.update((p) => p - 1);
        }
        this.load();
        this.loadCollections();
        this.notify.success('Book deleted');
      },
      error: (e) => this.reportError(e, 'Delete failed'),
    });
  }

  protected collectionsFor(book: Book): Collection[] {
    return this.collections().filter((c) => book.collection_ids.includes(c.id));
  }

  protected initials(title: string): string {
    const words = title.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '..';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  protected sizeLabel(bytes: number): string {
    if (!bytes) return '-';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  protected readingProgress(book: Book): number | null {
    if (!book.last_page || !book.page_count) return null;
    return Math.min(100, Math.max(1, Math.round((100 * book.last_page) / book.page_count)));
  }

  protected sortLabel(): string {
    return this.sort() === 'title' ? 'Title' : 'Date';
  }

  private load() {
    this.loading.set(true);
    this.error.set(null);
    this.library
      .list({
        search: this.search() || undefined,
        status: this.status(),
        sort: this.sort(),
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
          this.error.set(this.errorText(e, 'Failed to load library'));
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

  private patchBook(updated: Book) {
    this.books.update((list) => list.map((book) => (book.id === updated.id ? updated : book)));
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

  private validateImage(file: File, input: HTMLInputElement): boolean {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      const message = 'Cover must be a PNG, JPEG or WebP image';
      this.error.set(message);
      this.notify.error(message);
      input.value = '';
      return false;
    }
    if (file.size > MAX_COVER_MB * 1024 * 1024) {
      const message = `Cover exceeds ${MAX_COVER_MB} MB limit`;
      this.error.set(message);
      this.notify.error(message);
      input.value = '';
      return false;
    }
    this.error.set(null);
    return true;
  }

  private reportError(err: unknown, fallback: string) {
    const message = this.errorText(err, fallback);
    this.error.set(message);
    this.notify.error(message);
  }

  private errorText(err: unknown, fallback: string): string {
    const detail = (err as { error?: { detail?: unknown } })?.error?.detail;
    return typeof detail === 'string' && detail.trim() ? detail : fallback;
  }
}
