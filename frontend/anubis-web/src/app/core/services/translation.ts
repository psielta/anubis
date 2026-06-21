import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { TokenService } from './token';
import {
  TranslationCached,
  TranslationDone,
  TranslationRequest,
  TranslationStreamHandlers,
} from '../models/translation.model';

interface SseData {
  text?: string;
  page?: number;
  cached?: boolean;
  model?: string;
  detail?: string;
}

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private http = inject(HttpClient);
  private tokens = inject(TokenService);
  private base = environment.apiUrl;

  /** Fetch a previously cached translation for a page (404 if none yet). */
  cached(bookId: number, page: number): Observable<TranslationCached> {
    return this.http.get<TranslationCached>(`${this.base}/books/${bookId}/translate/${page}`);
  }

  /**
   * Stream a page translation over SSE. Uses fetch + ReadableStream (not
   * EventSource, which can't send the Authorization header), attaching the
   * bearer manually. Aborts are silent so navigating pages doesn't flash errors.
   */
  async translate(
    bookId: number,
    body: TranslationRequest,
    handlers: TranslationStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const token = this.tokens.accessToken();
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/books/${bookId}/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return;
      handlers.onError('Erro de rede — o servidor está rodando?');
      return;
    }

    if (!resp.ok || !resp.body) {
      let detail = `Falha na requisição (${resp.status}).`;
      try {
        const err = await resp.json();
        if (err?.detail) detail = err.detail;
      } catch {
        /* corpo de erro não-JSON */
      }
      if (resp.status === 401) detail = 'Sessão expirada — recarregue a página.';
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
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return;
      handlers.onError('O streaming foi interrompido.');
    }
  }

  private dispatch(frame: string, handlers: TranslationStreamHandlers): void {
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

    if (event === 'delta') handlers.onDelta(data.text ?? '');
    else if (event === 'done') handlers.onDone(data as TranslationDone);
    else if (event === 'error') handlers.onError(data.detail ?? 'A tradução falhou.');
  }
}
