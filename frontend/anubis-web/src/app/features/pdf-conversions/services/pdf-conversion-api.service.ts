import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface PdfConversionJob {
  id: string;
  original_filename: string;
  status: string;
  progress: number;
  page_count: number | null;
  error_code: string | null;
  error_message: string | null;
  total_chunks: number;
  retry_count: number;
  markdown_size: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ChunkSummary {
  chunk_index: number;
  title: string;
  page_start: number | null;
  page_end: number | null;
  content_length: number;
}

export interface ChunkRead extends ChunkSummary {
  content_markdown: string;
}

export interface TocEntry {
  chunk_index: number;
  title: string;
  depth: number;
}

export interface SearchHit {
  chunk_index: number;
  title: string;
  snippet: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
}

@Injectable({ providedIn: 'root' })
export class PdfConversionApiService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/pdf-conversions`;

  upload(file: File): Observable<{ job_id: string }> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<{ job_id: string }>(this.base, form);
  }

  getJob(id: string): Observable<PdfConversionJob> {
    return this.http.get<PdfConversionJob>(`${this.base}/${id}`);
  }

  listChunks(id: string): Observable<ChunkSummary[]> {
    return this.http.get<ChunkSummary[]>(`${this.base}/${id}/chunks`);
  }

  getChunk(id: string, chunkIndex: number): Observable<ChunkRead> {
    return this.http.get<ChunkRead>(`${this.base}/${id}/chunks/${chunkIndex}`);
  }

  getToc(id: string): Observable<TocEntry[]> {
    return this.http.get<TocEntry[]>(`${this.base}/${id}/toc`);
  }

  search(id: string, query: string): Observable<SearchResponse> {
    return this.http.get<SearchResponse>(`${this.base}/${id}/search`, {
      params: { q: query },
    });
  }

  downloadMarkdownUrl(id: string): string {
    return `${this.base}/${id}/markdown`;
  }

  retry(id: string): Observable<PdfConversionJob> {
    return this.http.post<PdfConversionJob>(`${this.base}/${id}/retry`, {});
  }

  cancel(id: string): Observable<PdfConversionJob> {
    return this.http.post<PdfConversionJob>(`${this.base}/${id}/cancel`, {});
  }

  eventsUrl(id: string): string {
    return `${this.base}/${id}/events`;
  }
}