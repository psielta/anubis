import { UpperCasePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { Book } from '../../../core/models/book.model';
import { CollectionShelf } from '../../../core/models/collection.model';
import { LibraryService } from '../../../core/services/library';
import { NotificationsService } from '../../../core/services/notifications';
import { UploadDialog } from '../upload-dialog/upload-dialog';

@Component({
  selector: 'app-series-library',
  imports: [
    UpperCasePipe,
    RouterLink,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatMenuModule,
  ],
  templateUrl: './series-library.html',
  styleUrl: './series-library.scss',
})
export class SeriesLibrary implements OnInit, OnDestroy {
  private library = inject(LibraryService);
  private sanitizer = inject(DomSanitizer);
  private dialog = inject(MatDialog);
  private notify = inject(NotificationsService);

  protected readonly series = signal<CollectionShelf[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly editingId = signal<number | null>(null);
  protected readonly collapsed = signal<Record<number, boolean>>({});
  protected readonly coverUrls = signal<Record<number, SafeUrl>>({});

  private coverRawUrls: Record<number, string> = {};

  ngOnInit() {
    this.load();
  }

  ngOnDestroy() {
    for (const url of Object.values(this.coverRawUrls)) URL.revokeObjectURL(url);
  }

  protected startCreate() {
    this.creating.set(true);
  }

  protected createSeries(name: string) {
    const trimmed = name.trim();
    this.creating.set(false);
    if (!trimmed) return;
    this.library.createCollection(trimmed).subscribe({
      next: () => {
        this.notify.success('Série criada');
        this.load();
      },
      error: (e) => this.reportError(e, 'Não foi possível criar a série'),
    });
  }

  protected startRename(series: CollectionShelf) {
    this.editingId.set(series.id);
  }

  protected renameSeries(series: CollectionShelf, name: string) {
    const trimmed = name.trim();
    this.editingId.set(null);
    if (!trimmed || trimmed === series.name) return;
    this.library.renameCollection(series.id, trimmed).subscribe({
      next: () => {
        this.notify.success('Série renomeada');
        this.load();
      },
      error: (e) => this.reportError(e, 'Não foi possível renomear a série'),
    });
  }

  protected deleteSeries(series: CollectionShelf) {
    this.library.deleteCollection(series.id).subscribe({
      next: () => {
        this.notify.success('Série excluída');
        this.load();
      },
      error: (e) => this.reportError(e, 'Não foi possível excluir a série'),
    });
  }

  protected toggleCollapsed(seriesId: number) {
    this.collapsed.update((value) => ({ ...value, [seriesId]: !value[seriesId] }));
  }

  protected openUpload(collectionId: number) {
    const ref = this.dialog.open(UploadDialog, {
      panelClass: 'anubis-dialog',
      width: '520px',
      autoFocus: false,
      data: { collectionId },
    });
    ref.afterClosed().subscribe((didUpload: boolean | undefined) => {
      if (didUpload) this.load();
    });
  }

  protected initials(title: string): string {
    const words = title.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '..';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  protected bookTrack(_: number, book: Book): number {
    return book.id;
  }

  private load() {
    this.loading.set(true);
    this.error.set(null);
    this.library.listCollectionShelf(12).subscribe({
      next: (series) => {
        this.series.set(series);
        this.loading.set(false);
        this.refreshCovers(series.flatMap((item) => item.items));
      },
      error: (e) => {
        this.error.set(this.errorText(e, 'Não foi possível carregar as séries'));
        this.loading.set(false);
      },
    });
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
