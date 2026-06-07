import { HttpClient, HttpEvent, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Book, BookPage } from '../models/book.model';
import { Collection } from '../models/collection.model';

export interface BookQuery {
  search?: string;
  collectionId?: number | null;
  page?: number;
  pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(query: BookQuery = {}): Observable<BookPage> {
    let params = new HttpParams()
      .set('page', query.page ?? 1)
      .set('page_size', query.pageSize ?? 12);
    if (query.search) params = params.set('search', query.search);
    if (query.collectionId != null) {
      params = params.set('collection_id', query.collectionId);
    }
    return this.http.get<BookPage>(`${this.base}/books`, { params });
  }

  listCollections(): Observable<Collection[]> {
    return this.http.get<Collection[]>(`${this.base}/collections`);
  }

  createCollection(name: string): Observable<Collection> {
    return this.http.post<Collection>(`${this.base}/collections`, { name });
  }

  renameCollection(id: number, name: string): Observable<Collection> {
    return this.http.patch<Collection>(`${this.base}/collections/${id}`, { name });
  }

  deleteCollection(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/collections/${id}`);
  }

  setBookCollections(id: number, collectionIds: number[]): Observable<Book> {
    return this.http.put<Book>(`${this.base}/books/${id}/collections`, {
      collection_ids: collectionIds,
    });
  }

  /** Upload a single PDF; title/author/page count are detected server-side. */
  import(file: File): Observable<HttpEvent<Book>> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Book>(`${this.base}/books`, form, {
      reportProgress: true,
      observe: 'events',
    });
  }

  /** Patch a book's editable details (title/author). */
  update(id: number, changes: { title?: string; author?: string | null }): Observable<Book> {
    return this.http.patch<Book>(`${this.base}/books/${id}`, changes);
  }

  get(id: number): Observable<Book> {
    return this.http.get<Book>(`${this.base}/books/${id}`);
  }

  download(id: number): Observable<Blob> {
    return this.http.get(`${this.base}/books/${id}/file`, { responseType: 'blob' });
  }

  uploadCover(id: number, cover: File): Observable<Book> {
    const form = new FormData();
    form.append('cover', cover);
    return this.http.post<Book>(`${this.base}/books/${id}/cover`, form);
  }

  getCover(id: number): Observable<Blob> {
    return this.http.get(`${this.base}/books/${id}/cover`, { responseType: 'blob' });
  }

  removeCover(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${id}/cover`);
  }

  saveProgress(id: number, lastPage: number, pageCount: number): Observable<Book> {
    return this.http.put<Book>(`${this.base}/books/${id}/progress`, {
      last_page: lastPage,
      page_count: pageCount,
    });
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${id}`);
  }
}
