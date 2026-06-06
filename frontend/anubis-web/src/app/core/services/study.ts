import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TokenService } from './token';
import {
  StudyDone,
  StudyKind,
  StudyMessage,
  StudyRequest,
  StudyStreamHandlers,
} from '../models/study.model';

interface SseData {
  text?: string;
  id?: number;
  scope?: string;
  kind?: StudyKind;
  detail?: string;
}

@Injectable({ providedIn: 'root' })
export class StudyService {
  private http = inject(HttpClient);
  private tokens = inject(TokenService);
  private base = environment.apiUrl;

  history(bookId: number): Observable<StudyMessage[]> {
    return this.http.get<StudyMessage[]>(`${this.base}/books/${bookId}/study`);
  }

  clear(bookId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/study`);
  }

  /**
   * Stream a study reply over SSE. Uses fetch + ReadableStream (not EventSource,
   * which can't send the Authorization header), attaching the bearer manually.
   */
  async ask(
    bookId: number,
    body: StudyRequest,
    handlers: StudyStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const token = this.tokens.accessToken();
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/books/${bookId}/study`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      handlers.onError('Network error — is the server running?');
      return;
    }

    if (!resp.ok || !resp.body) {
      let detail = `Request failed (${resp.status}).`;
      try {
        const err = await resp.json();
        if (err?.detail) detail = err.detail;
      } catch {
        /* non-JSON error body */
      }
      if (resp.status === 401) detail = 'Session expired — please reload.';
      handlers.onError(detail);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.dispatch(frame, handlers);
        }
      }
    } catch {
      handlers.onError('Streaming was interrupted.');
    }
  }

  private dispatch(frame: string, handlers: StudyStreamHandlers): void {
    let event = '';
    let dataLine = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
    }
    if (!event) return;

    let data: SseData = {};
    try {
      data = dataLine ? (JSON.parse(dataLine) as SseData) : {};
    } catch {
      return;
    }

    if (event === 'thinking') handlers.onThinking?.(data.text ?? '');
    else if (event === 'delta') handlers.onDelta(data.text ?? '');
    else if (event === 'done') handlers.onDone(data as StudyDone);
    else if (event === 'error') handlers.onError(data.detail ?? 'The AI request failed.');
  }
}
