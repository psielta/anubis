import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TokenService } from './token';
import { streamSse } from './sse';
import {
  StudyDone,
  StudyMessage,
  StudyRequest,
  StudyStreamHandlers,
} from '../models/study.model';

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
    await streamSse(
      `${this.base}/books/${bookId}/study`,
      body,
      {
        onFrame: ({ event, data }) => {
          if (event === 'thinking') handlers.onThinking?.((data['text'] as string) ?? '');
          else if (event === 'delta') handlers.onDelta((data['text'] as string) ?? '');
          else if (event === 'done') handlers.onDone(data as unknown as StudyDone);
          else if (event === 'error')
            handlers.onError((data['detail'] as string) ?? 'A requisição de IA falhou.');
        },
        onError: handlers.onError,
      },
      this.tokens.accessToken(),
      signal,
    );
  }
}
