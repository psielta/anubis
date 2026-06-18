import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  Sketch,
  SketchCreate,
  SketchGroup,
  SketchGroupCreate,
  SketchGroupUpdate,
  SketchUpdate,
} from '../models/sketch.model';

@Injectable({ providedIn: 'root' })
export class SketchesService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  listGroups(bookId: number): Observable<SketchGroup[]> {
    return this.http.get<SketchGroup[]>(`${this.base}/books/${bookId}/sketch-groups`);
  }

  createGroup(bookId: number, body: SketchGroupCreate): Observable<SketchGroup> {
    return this.http.post<SketchGroup>(`${this.base}/books/${bookId}/sketch-groups`, body);
  }

  updateGroup(
    bookId: number,
    id: number,
    body: SketchGroupUpdate,
  ): Observable<SketchGroup> {
    return this.http.patch<SketchGroup>(
      `${this.base}/books/${bookId}/sketch-groups/${id}`,
      body,
    );
  }

  removeGroup(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/sketch-groups/${id}`);
  }

  list(bookId: number): Observable<Sketch[]> {
    return this.http.get<Sketch[]>(`${this.base}/books/${bookId}/sketches`);
  }

  get(bookId: number, id: number): Observable<Sketch> {
    return this.http.get<Sketch>(`${this.base}/books/${bookId}/sketches/${id}`);
  }

  create(bookId: number, body: SketchCreate): Observable<Sketch> {
    return this.http.post<Sketch>(`${this.base}/books/${bookId}/sketches`, body);
  }

  update(bookId: number, id: number, body: SketchUpdate): Observable<Sketch> {
    return this.http.patch<Sketch>(`${this.base}/books/${bookId}/sketches/${id}`, body);
  }

  remove(bookId: number, id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/books/${bookId}/sketches/${id}`);
  }
}
