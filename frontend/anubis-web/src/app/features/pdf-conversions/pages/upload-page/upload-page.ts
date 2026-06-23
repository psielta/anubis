import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Router } from '@angular/router';
import { PdfConversionApiService } from '../../services/pdf-conversion-api.service';

const MAX_MB = 100;
const ACCEPT = ['.pdf'];

@Component({
  selector: 'app-upload-page',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './upload-page.html',
  styleUrl: './upload-page.scss',
})
export class UploadPage {
  private api = inject(PdfConversionApiService);
  private router = inject(Router);

  protected dragging = signal(false);
  protected error = signal<string | null>(null);
  protected uploading = signal(false);

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