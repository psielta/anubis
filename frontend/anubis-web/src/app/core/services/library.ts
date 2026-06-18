import { HttpClient, HttpEvent, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Book, BookPage, BookSort, BookStatus, ReaderState } from '../models/book.model';
import { Collection, CollectionShelf } from '../models/collection.model';

export interface BookQuery {
  search?: string;
  collectionId?: number | null;
  status?: BookStatus;
  sort?: BookSort;
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
    if (query.status && query.status !== 'all') {
      params = params.set('status', query.status);
    }
    if (query.sort) {
      params = params.set('sort', query.sort);
    }
    return this.http.get<BookPage>(`${this.base}/books`, { params });
  }

  listCollections(): Observable<Collection[]> {
    return this.http.get<Collection[]>(`${this.base}/collections`);
  }

  listCollectionShelf(limitPerCollection = 12): Observable<CollectionShelf[]> {
    const params = new HttpParams().set('limit_per_collection', limitPerCollection);
    return this.http.get<CollectionShelf[]>(`${this.base}/collections/shelf`, { params });
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

  reorderCollection(id: number, bookIds: number[]): Observable<Collection> {
    return this.http.put<Collection>(`${this.base}/collections/${id}/books/order`, {
      book_ids: bookIds,
    });
  }

  /** Upload a single PDF; title/author/page count are detected server-side. */
  import(file: File, collectionId?: number): Observable<HttpEvent<Book>> {
    const form = new FormData();
    form.append('file', file);
    if (collectionId != null) {
      form.append('collection_id', String(collectionId));
    }
    return this.http.post<Book>(`${this.base}/books`, form, {
      reportProgress: true,
      observe: 'events',
    });
  }

  /** Patch a book's editable details. */
  update(
    id: number,
    changes: { title?: string; author?: string | null; is_favorite?: boolean },
  ): Observable<Book> {
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

  saveReaderState(id: number, state: ReaderState): Observable<Book> {
    return this.http.put<Book>(`${this.base}/books/${id}/reader-state`, state);
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${id}`);
  }
}
