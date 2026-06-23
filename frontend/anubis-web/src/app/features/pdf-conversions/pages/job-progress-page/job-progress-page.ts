import { Component, OnDestroy, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { NotificationsService } from '../../../../core/services/notifications';
import { ProgressCard } from '../../components/progress-card/progress-card';
import {
  PdfConversionApiService,
  PdfConversionJob,
} from '../../services/pdf-conversion-api.service';
import { PdfConversionSseService } from '../../services/pdf-conversion-sse.service';

@Component({
  selector: 'app-job-progress-page',
  imports: [ProgressCard],
  templateUrl: './job-progress-page.html',
  styleUrl: './job-progress-page.scss',
})
export class JobProgressPage implements OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(PdfConversionApiService);
  private sse = inject(PdfConversionSseService);
  private notify = inject(NotificationsService);

  protected job = signal<PdfConversionJob | null>(null);
  protected liveMessage = signal<string | null>(null);
  protected loadError = signal<string | null>(null);

  private abort = new AbortController();
  private pollSub: Subscription | null = null;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.loadError.set('Job inválido');
      return;
    }
    this.loadJob(id);
    this.connectSse(id);
  }

  ngOnDestroy() {
    this.abort.abort();
    this.pollSub?.unsubscribe();
  }

  private loadJob(id: string) {
    this.api.getJob(id).subscribe({
      next: (j) => {
        this.job.set(j);
        if (this.sse.isTerminal(j.status)) return;
      },
      error: () => this.loadError.set('Conversão não encontrada'),
    });
  }

  private connectSse(id: string) {
    void this.sse.connect(
      id,
      {
        onEvent: (ev) => {
          this.job.update((j) =>
            j
              ? {
                  ...j,
                  status: ev.status,
                  progress: ev.progress,
                  error_code: ev.error_code,
                  error_message: ev.error_message,
                }
              : j,
          );
          if (ev.message) this.liveMessage.set(ev.message);
        },
        onError: (msg) => {
          if (!this.abort.signal.aborted) this.notify.error(msg);
        },
        onTerminal: () => {
          this.loadJob(id);
        },
      },
      this.abort.signal,
    );
  }

  retry() {
    const id = this.job()?.id;
    if (!id) return;
    this.api.retry(id).subscribe({
      next: (j) => {
        this.job.set(j);
        this.liveMessage.set(null);
        this.connectSse(id);
      },
      error: (e) => this.notify.error(e?.error?.detail ?? 'Retry falhou'),
    });
  }

  cancel() {
    const id = this.job()?.id;
    if (!id) return;
    this.api.cancel(id).subscribe({
      next: (j) => this.job.set(j),
      error: (e) => this.notify.error(e?.error?.detail ?? 'Cancelamento falhou'),
    });
  }

  openReader() {
    const id = this.job()?.id;
    if (id) void this.router.navigate(['/pdf-conversions', id, 'read']);
  }
}