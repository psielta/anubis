import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  LatexNotebook,
  LatexNotebookCreate,
  LatexNotebookGroup,
  LatexNotebookGroupCreate,
  LatexNotebookGroupUpdate,
  LatexNotebookUpdate,
} from '../models/latex-notebook.model';

@Injectable({ providedIn: 'root' })
export class LatexNotebooksService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  listGroups(bookId: number): Observable<LatexNotebookGroup[]> {
    return this.http.get<LatexNotebookGroup[]>(
      `${this.base}/books/${bookId}/latex-notebook-groups`,
    );
  }

  createGroup(
    bookId: number,
    body: LatexNotebookGroupCreate,
  ): Observable<LatexNotebookGroup> {
    return this.http.post<LatexNotebookGroup>(
      `${this.base}/books/${bookId}/latex-notebook-groups`,
      body,
    );
  }

  updateGroup(
    bookId: number,
    id: number,
    body: LatexNotebookGroupUpdate,
  ): Observable<LatexNotebookGroup> {
    return this.http.patch<LatexNotebookGroup>(
      `${this.base}/books/${bookId}/latex-notebook-groups/${id}`,
      body,
    );
  }

  removeGroup(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(
      `${this.base}/books/${bookId}/latex-notebook-groups/${id}`,
    );
  }

  list(bookId: number): Observable<LatexNotebook[]> {
    return this.http.get<LatexNotebook[]>(`${this.base}/books/${bookId}/latex-notebooks`);
  }

  get(bookId: number, id: number): Observable<LatexNotebook> {
    return this.http.get<LatexNotebook>(`${this.base}/books/${bookId}/latex-notebooks/${id}`);
  }

  create(bookId: number, body: LatexNotebookCreate): Observable<LatexNotebook> {
    return this.http.post<LatexNotebook>(`${this.base}/books/${bookId}/latex-notebooks`, body);
  }

  update(bookId: number, id: number, body: LatexNotebookUpdate): Observable<LatexNotebook> {
    return this.http.patch<LatexNotebook>(
      `${this.base}/books/${bookId}/latex-notebooks/${id}`,
      body,
    );
  }

  remove(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/latex-notebooks/${id}`);
  }
}
