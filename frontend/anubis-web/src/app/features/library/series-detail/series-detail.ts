import { UpperCasePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { Book } from '../../../core/models/book.model';
import { LibraryService } from '../../../core/services/library';
import { NotificationsService } from '../../../core/services/notifications';
import { EditBookDialog } from '../edit-book-dialog/edit-book-dialog';
import { UploadDialog } from '../upload-dialog/upload-dialog';

@Component({
  selector: 'app-series-detail',
  imports: [
    UpperCasePipe,
    RouterLink,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatMenuModule,
  ],
  templateUrl: './series-detail.html',
  styleUrl: './series-detail.scss',
})
export class SeriesDetail implements OnInit, OnDestroy {
  private library = inject(LibraryService);
  private sanitizer = inject(DomSanitizer);
  private route = inject(ActivatedRoute);
  private dialog = inject(MatDialog);
  private notify = inject(NotificationsService);

  protected readonly seriesName = signal('Series');
  protected readonly allBooks = signal<Book[]>([]);
  protected readonly total = signal(0);
  protected readonly search = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly coverUrls = signal<Record<number, SafeUrl>>({});
  protected readonly visibleBooks = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.allBooks();
    return this.allBooks().filter((book) => {
      const author = book.author?.toLowerCase() ?? '';
      return book.title.toLowerCase().includes(term) || author.includes(term);
    });
  });

  private readonly collectionId = Number(this.route.snapshot.paramMap.get('id'));
  private coverRawUrls: Record<number, string> = {};

  ngOnInit() {
    this.loadSeriesName();
    this.loadBooks();
  }

  ngOnDestroy() {
    for (const url of Object.values(this.coverRawUrls)) URL.revokeObjectURL(url);
  }

  protected onSearch(event: Event) {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected openUpload() {
    const ref = this.dialog.open(UploadDialog, {
      panelClass: 'anubis-dialog',
      width: '520px',
      autoFocus: false,
      data: { collectionId: this.collectionId },
    });
    ref.afterClosed().subscribe((didUpload: boolean | undefined) => {
      if (didUpload) this.loadBooks();
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

  protected move(book: Book, delta: -1 | 1) {
    const current = this.allBooks();
    const index = current.findIndex((item) => item.id === book.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= current.length) return;

    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    this.persistOrder(next, current);
  }

  protected canMove(book: Book, delta: -1 | 1): boolean {
    const index = this.allBooks().findIndex((item) => item.id === book.id);
    if (index < 0) return false;
    const target = index + delta;
    return target >= 0 && target < this.allBooks().length;
  }

  protected removeFromSeries(book: Book) {
    const ids = book.collection_ids.filter((id) => id !== this.collectionId);
    this.library.setBookCollections(book.id, ids).subscribe({
      next: () => {
        this.allBooks.update((books) => books.filter((item) => item.id !== book.id));
        this.total.update((value) => Math.max(0, value - 1));
        this.notify.success('Removed from series');
      },
      error: (e) => this.reportError(e, 'Could not remove from series'),
    });
  }

  protected toggleFavorite(book: Book) {
    this.library.update(book.id, { is_favorite: !book.is_favorite }).subscribe({
      next: (updated) => this.patchBook(updated),
      error: (e) => this.reportError(e, 'Could not update favorite'),
    });
  }

  protected initials(title: string): string {
    const words = title.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '..';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  protected readingProgress(book: Book): number | null {
    if (!book.last_page || !book.page_count) return null;
    return Math.min(100, Math.max(1, Math.round((100 * book.last_page) / book.page_count)));
  }

  private loadSeriesName() {
    this.library.listCollections().subscribe({
      next: (collections) => {
        const series = collections.find((item) => item.id === this.collectionId);
        if (series) this.seriesName.set(series.name);
      },
      error: () => {},
    });
  }

  private loadBooks() {
    this.loading.set(true);
    this.error.set(null);
    this.library
      .list({
        collectionId: this.collectionId,
        sort: 'series',
        page: 1,
        pageSize: 100,
      })
      .subscribe({
        next: (result) => {
          this.allBooks.set(result.items);
          this.total.set(result.total);
          this.loading.set(false);
          this.refreshCovers(result.items);
        },
        error: (e) => {
          this.error.set(this.errorText(e, 'Failed to load series books'));
          this.loading.set(false);
        },
      });
  }

  private persistOrder(next: Book[], previous: Book[]) {
    this.allBooks.set(next);
    this.library.reorderCollection(this.collectionId, next.map((book) => book.id)).subscribe({
      next: () => this.notify.success('Series order updated'),
      error: (e) => {
        this.allBooks.set(previous);
        this.reportError(e, 'Could not reorder series');
      },
    });
  }

  private patchBook(updated: Book) {
    this.allBooks.update((list) => list.map((book) => (book.id === updated.id ? updated : book)));
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
