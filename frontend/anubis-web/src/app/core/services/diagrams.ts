import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Diagram, DiagramCreate, DiagramUpdate } from '../models/diagram.model';

@Injectable({ providedIn: 'root' })
export class DiagramsService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(bookId: number): Observable<Diagram[]> {
    return this.http.get<Diagram[]>(`${this.base}/books/${bookId}/diagrams`);
  }

  get(bookId: number, id: number): Observable<Diagram> {
    return this.http.get<Diagram>(`${this.base}/books/${bookId}/diagrams/${id}`);
  }

  create(bookId: number, body: DiagramCreate): Observable<Diagram> {
    return this.http.post<Diagram>(`${this.base}/books/${bookId}/diagrams`, body);
  }

  update(bookId: number, id: number, body: DiagramUpdate): Observable<Diagram> {
    return this.http.patch<Diagram>(`${this.base}/books/${bookId}/diagrams/${id}`, body);
  }

  remove(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/diagrams/${id}`);
  }
}
