import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { PdfConversionJob } from '../../services/pdf-conversion-api.service';

@Component({
  selector: 'app-progress-card',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule],
  templateUrl: './progress-card.html',
  styleUrl: './progress-card.scss',
})
export class ProgressCard {
  readonly job = input.required<PdfConversionJob>();
  readonly liveMessage = input<string | null>(null);
  readonly retry = output<void>();
  readonly cancel = output<void>();
  readonly openReader = output<void>();

  statusLabel(status: string): string {
    const labels: Record<string, string> = {
      pending: 'Na fila',
      processing: 'Convertendo',
      chunking: 'Gerando seções',
      completed: 'Concluído',
      failed: 'Falhou',
      canceled: 'Cancelado',
    };
    return labels[status] ?? status;
  }
}