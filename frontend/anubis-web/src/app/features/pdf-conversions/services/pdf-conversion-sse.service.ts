import { Injectable, inject } from '@angular/core';
import { streamSseGet, SseFrame } from '../../../core/services/sse';
import { TokenService } from '../../../core/services/token';
import { PdfConversionApiService, PdfConversionJob } from './pdf-conversion-api.service';

export interface ProgressEvent {
  job_id: string;
  status: string;
  progress: number;
  message: string | null;
  error_code: string | null;
  error_message: string | null;
  timestamp: string;
  seq: number | null;
}

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

@Injectable({ providedIn: 'root' })
export class PdfConversionSseService {
  private api = inject(PdfConversionApiService);
  private tokens = inject(TokenService);

  connect(
    jobId: string,
    handlers: {
      onEvent: (event: ProgressEvent) => void;
      onError: (message: string) => void;
      onTerminal?: () => void;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    return streamSseGet(
      this.api.eventsUrl(jobId),
      {
        onFrame: (frame: SseFrame) => {
          if (frame.event !== 'progress') return;
          const data = frame.data as unknown as ProgressEvent;
          handlers.onEvent(data);
          if (TERMINAL.has(data.status)) handlers.onTerminal?.();
        },
        onError: handlers.onError,
        onComplete: handlers.onTerminal,
      },
      this.tokens.accessToken(),
      signal,
    );
  }

  isTerminal(status: string): boolean {
    return TERMINAL.has(status);
  }

  mapJobToEvent(job: PdfConversionJob): ProgressEvent {
    return {
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      message: null,
      error_code: job.error_code,
      error_message: job.error_message,
      timestamp: job.updated_at,
      seq: 0,
    };
  }
}