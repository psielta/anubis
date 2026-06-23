import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NotificationsService } from '../../../../core/services/notifications';
import { MarkdownReader } from '../../components/markdown-reader/markdown-reader';
import {
  ChunkRead,
  ChunkSummary,
  PdfConversionApiService,
  TocEntry,
} from '../../services/pdf-conversion-api.service';

@Component({
  selector: 'app-markdown-reader-page',
  imports: [MarkdownReader],
  templateUrl: './markdown-reader-page.html',
  styleUrl: './markdown-reader-page.scss',
})
export class MarkdownReaderPage {
  private route = inject(ActivatedRoute);
  private api = inject(PdfConversionApiService);
  private http = inject(HttpClient);
  private notify = inject(NotificationsService);

  protected jobId = signal('');
  protected filename = signal('');
  protected chunks = signal<ChunkSummary[]>([]);
  protected toc = signal<TocEntry[]>([]);
  protected chunk = signal<ChunkRead | null>(null);
  protected loading = signal(false);
  protected error = signal<string | null>(null);

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.error.set('Job inválido');
      return;
    }
    this.jobId.set(id);
    this.api.getJob(id).subscribe({
      next: (job) => {
        this.filename.set(job.original_filename);
        if (job.status !== 'completed') {
          this.error.set('Markdown ainda não está pronto');
          return;
        }
        this.api.getToc(id).subscribe({
          next: (entries) => this.toc.set(entries),
        });
        this.api.listChunks(id).subscribe({
          next: (list) => {
            this.chunks.set(list);
            if (list.length) this.loadChunk(id, list[0].chunk_index);
          },
          error: () => this.error.set('Não foi possível carregar as seções'),
        });
      },
      error: () => this.error.set('Conversão não encontrada'),
    });
  }

  loadChunk(jobId: string, index: number) {
    this.loading.set(true);
    this.api.getChunk(jobId, index).subscribe({
      next: (c) => {
        this.chunk.set(c);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notify.error('Não foi possível carregar a seção');
      },
    });
  }

  onNavigate(index: number) {
    this.loadChunk(this.jobId(), index);
  }

  onCopy() {
    const text = this.chunk()?.content_markdown;
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      this.notify.success('Seção copiada');
    });
  }

  onDownload() {
    const url = this.api.downloadMarkdownUrl(this.jobId());
    this.http.get(url, { responseType: 'text' }).subscribe({
      next: (text) => {
        const blob = new Blob([text], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${this.filename()}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      error: () => this.notify.error('Download falhou'),
    });
  }
}