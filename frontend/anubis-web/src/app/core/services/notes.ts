import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Note, NoteCreate, NoteUpdate } from '../models/note.model';

@Injectable({ providedIn: 'root' })
export class NotesService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(bookId: number, q?: string): Observable<Note[]> {
    return this.http.get<Note[]>(`${this.base}/books/${bookId}/notes`, {
      params: q ? { q } : {},
    });
  }

  get(bookId: number, id: number): Observable<Note> {
    return this.http.get<Note>(`${this.base}/books/${bookId}/notes/${id}`);
  }

  create(bookId: number, body: NoteCreate): Observable<Note> {
    return this.http.post<Note>(`${this.base}/books/${bookId}/notes`, body);
  }

  update(bookId: number, id: number, body: NoteUpdate): Observable<Note> {
    return this.http.patch<Note>(`${this.base}/books/${bookId}/notes/${id}`, body);
  }

  remove(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/notes/${id}`);
  }
}
