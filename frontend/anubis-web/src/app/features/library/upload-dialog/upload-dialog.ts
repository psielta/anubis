import { HttpEventType } from '@angular/common/http';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Subscription } from 'rxjs';
import { UploadItem, UploadStatus } from '../../../core/models/book.model';
import { LibraryService } from '../../../core/services/library';
import { NotificationsService } from '../../../core/services/notifications';

const MAX_UPLOAD_MB = 250;
const ACCEPTED_EXTENSIONS = ['.pdf'];

@Component({
  selector: 'app-upload-dialog',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule],
  templateUrl: './upload-dialog.html',
  styleUrl: './upload-dialog.scss',
})
export class UploadDialog implements OnDestroy {
  private library = inject(LibraryService);
  private notify = inject(NotificationsService);
  private dialogRef = inject<MatDialogRef<UploadDialog, boolean>>(MatDialogRef);

  protected readonly queue = signal<UploadItem[]>([]);
  protected readonly dragging = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasCompleted = computed(() =>
    this.queue().some((i) => i.status === 'done' || i.status === 'error'),
  );

  private uploadSeq = 0;
  private uploadSub: Subscription | null = null;
  private running = false;
  private didUpload = false;

  constructor() {
    // Route every close path (button, backdrop, Esc) through close() so the
    // library always learns whether any upload landed.
    this.dialogRef.disableClose = true;
    this.dialogRef.backdropClick().subscribe(() => this.close());
    this.dialogRef.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape') this.close();
    });
  }

  ngOnDestroy() {
    this.uploadSub?.unsubscribe();
  }

  close() {
    this.dialogRef.close(this.didUpload);
  }

  private errorText(err: unknown, fallback: string): string {
    const detail = (err as { error?: { detail?: unknown } })?.error?.detail;
    return typeof detail === 'string' && detail.trim() ? detail : fallback;
  }

  onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    this.error.set(null);
    if (input.files) this.enqueueFiles(input.files);
    input.value = ''; // allow re-selecting the same file
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    this.error.set(null);
    const files = event.dataTransfer?.files;
    if (files?.length) this.enqueueFiles(files);
  }

  removeQueued(id: number) {
    this.queue.update((q) => q.filter((i) => !(i.id === id && i.status !== 'uploading')));
  }

  clearCompleted() {
    this.queue.update((q) => q.filter((i) => i.status === 'queued' || i.status === 'uploading'));
  }

  /** Human-readable file size. */
  sizeLabel(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** Material icon ligature for a queue item's status. */
  statusIcon(status: UploadStatus): string {
    switch (status) {
      case 'done':
        return 'check_circle';
      case 'error':
        return 'error';
      case 'uploading':
        return 'sync';
      default:
        return 'schedule';
    }
  }

  private enqueueFiles(files: FileList | File[]) {
    const additions: UploadItem[] = [];
    for (const file of Array.from(files)) {
      const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        const message = `${file.name}: only PDF files are supported`;
        this.error.set(message);
        this.notify.error(message);
        continue;
      }
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        const message = `${file.name}: exceeds ${MAX_UPLOAD_MB} MB limit`;
        this.error.set(message);
        this.notify.error(message);
        continue;
      }
      additions.push({ id: ++this.uploadSeq, file, status: 'queued', progress: 0 });
    }
    if (!additions.length) return;
    this.queue.update((q) => [...q, ...additions]);
    this.pump();
  }

  /** Drain the queue one item at a time; a failure never stops the rest. */
  private pump() {
    if (this.running) return;
    const next = this.queue().find((i) => i.status === 'queued');
    if (!next) return;
    this.running = true;
    this.patchItem(next.id, { status: 'uploading', progress: 0 });

    this.uploadSub = this.library.import(next.file).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress && event.total) {
          this.patchItem(next.id, {
            progress: Math.round((100 * event.loaded) / event.total),
          });
        }
        if (event.type === HttpEventType.Response) {
          this.didUpload = true;
          this.patchItem(next.id, {
            status: 'done',
            progress: 100,
            book: event.body ?? undefined,
          });
          this.notify.success(`${next.file.name} imported`);
        }
      },
      error: (e) => {
        const message = this.errorText(e, 'Upload failed');
        this.patchItem(next.id, {
          status: 'error',
          error: message,
        });
        this.notify.error(message);
        this.running = false;
        this.pump();
      },
      // RxJS never emits complete after error, so pump() is driven from both.
      complete: () => {
        this.running = false;
        this.pump();
      },
    });
  }

  private patchItem(id: number, changes: Partial<UploadItem>) {
    this.queue.update((q) => q.map((i) => (i.id === id ? { ...i, ...changes } : i)));
  }
}
