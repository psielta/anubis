import { UpperCasePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { LibraryService } from '../../core/services/library';
import { Book } from '../../core/models/book.model';

const MAX_UPLOAD_MB = 50;
const ACCEPTED_EXTENSIONS = ['.pdf', '.epub'];

@Component({
  selector: 'app-library',
  imports: [
    UpperCasePipe,
    ReactiveFormsModule,
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
export class Library implements OnInit {
  private fb = inject(FormBuilder);
  private library = inject(LibraryService);

  protected readonly books = signal<Book[]>([]);
  protected readonly loading = signal(false);
  protected readonly uploading = signal(false);
  protected readonly progress = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedFile = signal<File | null>(null);

  protected form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(512)]],
    author: ['', [Validators.maxLength(255)]],
  });

  ngOnInit() {
    this.loadBooks();
  }

  private loadBooks() {
    this.loading.set(true);
    this.error.set(null);
    this.library.list().subscribe({
      next: (books) => {
        this.books.set(books);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.detail ?? 'Failed to load library');
        this.loading.set(false);
      },
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
      this.error.set('Only PDF and EPUB files are supported');
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

  import() {
    const file = this.selectedFile();
    if (!file || this.form.invalid) return;

    const { title, author } = this.form.getRawValue();
    this.uploading.set(true);
    this.progress.set(0);
    this.error.set(null);

    this.library.import(title, author || null, file).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress && event.total) {
          this.progress.set(Math.round((100 * event.loaded) / event.total));
        }
        if (event.type === HttpEventType.Response && event.body) {
          this.books.update((books) => [event.body!, ...books]);
          this.form.reset();
          this.selectedFile.set(null);
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
      next: () => this.books.update((books) => books.filter((b) => b.id !== book.id)),
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