import { HttpClient, HttpEvent } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Book } from '../models/book.model';

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(): Observable<Book[]> {
    return this.http.get<Book[]>(`${this.base}/books`);
  }

  import(
    title: string,
    author: string | null,
    file: File,
    cover: File | null = null,
  ): Observable<HttpEvent<Book>> {
    const form = new FormData();
    form.append('title', title);
    if (author) form.append('author', author);
    form.append('file', file);
    if (cover) form.append('cover', cover);
    return this.http.post<Book>(`${this.base}/books`, form, {
      reportProgress: true,
      observe: 'events',
    });
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

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${id}`);
  }
}