import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  map,
  of,
  switchMap,
  takeWhile,
  throwError,
  timer,
} from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  RagActivateResponse,
  RagQueryRequest,
  RagQueryResponse,
  RagStatusResponse,
} from '../models/rag.model';
import {
  RagUiStatus,
  mapApiStatus,
  shouldContinuePolling,
} from '../utils/rag-ui';

export interface RagStatusView {
  uiStatus: RagUiStatus;
  progress: number;
  chunkCount: number;
  errorMessage: string | null;
  raw: RagStatusResponse | null;
}

@Injectable({ providedIn: 'root' })
export class RagService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  private url(bookId: number, suffix: string): string {
    return `${this.base}/books/${bookId}/rag/${suffix}`;
  }

  activate(bookId: number): Observable<RagActivateResponse> {
    return this.http.post<RagActivateResponse>(this.url(bookId, 'activate'), {});
  }

  reprocess(bookId: number): Observable<RagActivateResponse> {
    return this.http.post<RagActivateResponse>(this.url(bookId, 'reprocess'), {});
  }

  status(bookId: number): Observable<RagStatusResponse> {
    return this.http.get<RagStatusResponse>(this.url(bookId, 'status'));
  }

  /**
   * Status for UI: 404 → not_indexed; other errors rethrow.
   */
  statusView(bookId: number): Observable<RagStatusView> {
    return this.status(bookId).pipe(
      map((raw) => this.toView(raw)),
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 404) {
          return of({
            uiStatus: 'not_indexed' as const,
            progress: 0,
            chunkCount: 0,
            errorMessage: null,
            raw: null,
          });
        }
        return throwError(() => err);
      }),
    );
  }

  query(
    bookId: number,
    body: RagQueryRequest,
  ): Observable<RagQueryResponse> {
    return this.http.post<RagQueryResponse>(this.url(bookId, 'query'), {
      question: body.question,
      top_k: body.top_k ?? 5,
    });
  }

  /**
   * Poll status every `intervalMs` until completed/failed/not_indexed.
   * Emits the latest view on each tick, including the terminal one.
   */
  pollStatus(bookId: number, intervalMs = 2000): Observable<RagStatusView> {
    return timer(0, intervalMs).pipe(
      switchMap(() => this.statusView(bookId)),
      takeWhile((view) => shouldContinuePolling(view.uiStatus), true),
    );
  }

  private toView(raw: RagStatusResponse): RagStatusView {
    return {
      uiStatus: mapApiStatus(raw.status),
      progress: raw.progress ?? 0,
      chunkCount: raw.chunk_count ?? 0,
      errorMessage: raw.error_message,
      raw,
    };
  }
}
