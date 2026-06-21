import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TokenService } from './token';
import { streamSse } from './sse';
import {
  ExerciseAIHandlers,
  ExerciseAIMode,
  ExerciseAIRequest,
  ExerciseAttempt,
  ExerciseChatHandlers,
  ExerciseChatMessage,
  ExerciseChatRequest,
  ExerciseResolution,
  ExerciseResolutionCreate,
  ExerciseResolutionUpdate,
} from '../models/exercise-resolution.model';

@Injectable({ providedIn: 'root' })
export class ExerciseResolutionsService {
  private http = inject(HttpClient);
  private tokens = inject(TokenService);
  private base = environment.apiUrl;

  private url(bookId: number): string {
    return `${this.base}/books/${bookId}/exercise-resolutions`;
  }

  list(bookId: number): Observable<ExerciseResolution[]> {
    return this.http.get<ExerciseResolution[]>(this.url(bookId));
  }

  get(bookId: number, id: number): Observable<ExerciseResolution> {
    return this.http.get<ExerciseResolution>(`${this.url(bookId)}/${id}`);
  }

  create(
    bookId: number,
    body: ExerciseResolutionCreate,
  ): Observable<ExerciseResolution> {
    return this.http.post<ExerciseResolution>(this.url(bookId), body);
  }

  update(
    bookId: number,
    id: number,
    body: ExerciseResolutionUpdate,
  ): Observable<ExerciseResolution> {
    return this.http.patch<ExerciseResolution>(`${this.url(bookId)}/${id}`, body);
  }

  remove(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.url(bookId)}/${id}`);
  }

  listAttempts(bookId: number, id: number): Observable<ExerciseAttempt[]> {
    return this.http.get<ExerciseAttempt[]>(`${this.url(bookId)}/${id}/attempts`);
  }

  createAttempt(bookId: number, id: number): Observable<ExerciseAttempt> {
    return this.http.post<ExerciseAttempt>(`${this.url(bookId)}/${id}/attempts`, {});
  }

  listChat(bookId: number, id: number): Observable<ExerciseChatMessage[]> {
    return this.http.get<ExerciseChatMessage[]>(`${this.url(bookId)}/${id}/chat`);
  }

  clearChat(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.url(bookId)}/${id}/chat`);
  }

  /** Stream an AI action (clean statement / hint / review) over SSE. */
  async askAI(
    bookId: number,
    id: number,
    body: ExerciseAIRequest,
    handlers: ExerciseAIHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    await streamSse(
      `${this.url(bookId)}/${id}/ai`,
      body,
      {
        onFrame: ({ event, data }) => {
          if (event === 'thinking') handlers.onThinking?.((data['text'] as string) ?? '');
          else if (event === 'delta') handlers.onDelta((data['text'] as string) ?? '');
          else if (event === 'done')
            handlers.onDone({
              mode: data['mode'] as ExerciseAIMode,
              content: (data['content'] as string) ?? '',
            });
          else if (event === 'error')
            handlers.onError((data['detail'] as string) ?? 'A requisição de IA falhou.');
        },
        onError: handlers.onError,
      },
      this.tokens.accessToken(),
      signal,
    );
  }

  /** Stream a tutor-chat reply over SSE (history is kept server-side). */
  async chat(
    bookId: number,
    id: number,
    body: ExerciseChatRequest,
    handlers: ExerciseChatHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    await streamSse(
      `${this.url(bookId)}/${id}/chat`,
      body,
      {
        onFrame: ({ event, data }) => {
          if (event === 'thinking') handlers.onThinking?.((data['text'] as string) ?? '');
          else if (event === 'delta') handlers.onDelta((data['text'] as string) ?? '');
          else if (event === 'done') handlers.onDone({ id: (data['id'] as number) ?? 0 });
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
