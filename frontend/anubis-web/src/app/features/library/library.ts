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
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { LibraryService } from '../../core/services/library';
import { Book } from '../../core/models/book.model';

const MAX_UPLOAD_MB = 50;
const MAX_COVER_MB = 5;
const ACCEPTED_EXTENSIONS = ['.pdf'];
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

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
  ],
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private library = inject(LibraryService);
  private sanitizer = inject(DomSanitizer);

  protected readonly books = signal<Book[]>([]);
  protected readonly loading = signal(false);
  protected readonly uploading = signal(false);
  protected readonly progress = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedFile = signal<File | null>(null);
  protected readonly selectedCover = signal<File | null>(null);
  protected readonly coverPreview = signal<SafeUrl | null>(null);

  /** Sanitized blob URLs for grid thumbnails, keyed by book id. */
  protected readonly coverUrls = signal<Record<number, SafeUrl>>({});
  /** Raw object URLs kept for revocation (thumbnails + import preview). */
  private coverRawUrls: Record<number, string> = {};
  private coverPreviewRaw: string | null = null;

  protected form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(512)]],
    author: ['', [Validators.maxLength(255)]],
  });

  ngOnInit() {
    this.loadBooks();
  }

  ngOnDestroy() {
    for (const url of Object.values(this.coverRawUrls)) URL.revokeObjectURL(url);
    if (this.coverPreviewRaw) URL.revokeObjectURL(this.coverPreviewRaw);
  }

  private loadBooks() {
    this.loading.set(true);
    this.error.set(null);
    this.library.list().subscribe({
      next: (books) => {
        this.books.set(books);
        this.loading.set(false);
        this.refreshCovers(books);
      },
      error: (e) => {
        this.error.set(e?.error?.detail ?? 'Failed to load library');
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
        if (event.type === HttpEventType.Response && event.body) {
          const book = event.body;
          this.books.update((books) => [book, ...books]);
          if (book.has_cover) this.loadCover(book.id);
          this.form.reset();
          this.selectedFile.set(null);
          this.clearCover();
          this.uploading.set(false);
          this.progress.set(0);
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
        this.books.update((books) => books.filter((b) => b.id !== book.id));
        const raw = this.coverRawUrls[book.id];
        if (raw) {
          URL.revokeObjectURL(raw);
          delete this.coverRawUrls[book.id];
        }
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
}
