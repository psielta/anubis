import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import {
  PdfConversionApiService,
  PdfConversionJob,
} from '../../services/pdf-conversion-api.service';

const MAX_MB = 100;
const ACCEPT = ['.pdf'];

const STATUS_LABELS: Record<string, string> = {
  pending: 'Na fila',
  processing: 'Convertendo',
  chunking: 'Organizando',
  completed: 'Concluída',
  failed: 'Falhou',
  canceled: 'Cancelada',
};

@Component({
  selector: 'app-upload-page',
  imports: [MatButtonModule, MatIconModule, RouterLink, DatePipe],
  templateUrl: './upload-page.html',
  styleUrl: './upload-page.scss',
})
export class UploadPage implements OnInit {
  private api = inject(PdfConversionApiService);
  private router = inject(Router);

  protected dragging = signal(false);
  protected error = signal<string | null>(null);
  protected uploading = signal(false);
  protected jobs = signal<PdfConversionJob[]>([]);
  protected jobsLoading = signal(true);

  ngOnInit() {
    this.loadJobs();
  }

  statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
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
    const file = event.dataTransfer?.files?.[0];
    if (file) this.upload(file);
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.upload(file);
    input.value = '';
  }

  private loadJobs() {
    this.jobsLoading.set(true);
    this.api.listJobs().subscribe({
      next: (items) => {
        this.jobs.set(items);
        this.jobsLoading.set(false);
      },
      error: () => this.jobsLoading.set(false),
    });
  }

  private upload(file: File) {
    this.error.set(null);
    const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '');
    if (!ACCEPT.includes(ext)) {
      this.error.set('Apenas arquivos PDF são suportados');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      this.error.set(`O arquivo excede o limite de ${MAX_MB} MB`);
      return;
    }

    this.uploading.set(true);
    this.api.upload(file).subscribe({
      next: (res) => {
        this.uploading.set(false);
        void this.router.navigate(['/pdf-conversions', res.job_id]);
      },
      error: (e) => {
        this.uploading.set(false);
        const detail = e?.error?.detail;
        this.error.set(typeof detail === 'string' ? detail : 'Falha no envio');
      },
    });
  }
}