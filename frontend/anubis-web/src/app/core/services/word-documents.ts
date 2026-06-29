import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  OnlyOfficeEditorConfig,
  WordDocument,
  WordDocumentCreate,
  WordDocumentUpdate,
} from '../models/word-document.model';

@Injectable({ providedIn: 'root' })
export class WordDocumentsService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(bookId: number): Observable<WordDocument[]> {
    return this.http.get<WordDocument[]>(`${this.base}/books/${bookId}/word-documents`);
  }

  get(bookId: number, id: number): Observable<WordDocument> {
    return this.http.get<WordDocument>(`${this.base}/books/${bookId}/word-documents/${id}`);
  }

  create(bookId: number, body: WordDocumentCreate): Observable<WordDocument> {
    return this.http.post<WordDocument>(`${this.base}/books/${bookId}/word-documents`, body);
  }

  update(bookId: number, id: number, body: WordDocumentUpdate): Observable<WordDocument> {
    return this.http.patch<WordDocument>(
      `${this.base}/books/${bookId}/word-documents/${id}`,
      body,
    );
  }

  remove(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/word-documents/${id}`);
  }

  download(bookId: number, id: number): Observable<Blob> {
    return this.http.get(`${this.base}/books/${bookId}/word-documents/${id}/download`, {
      responseType: 'blob',
    });
  }

  editorConfig(bookId: number, id: number): Observable<OnlyOfficeEditorConfig> {
    return this.http.post<OnlyOfficeEditorConfig>(
      `${this.base}/books/${bookId}/word-documents/${id}/onlyoffice-config`,
      {},
    );
  }
}
