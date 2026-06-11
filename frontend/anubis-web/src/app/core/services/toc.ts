import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Book, TocEntry } from '../models/book.model';

@Injectable({ providedIn: 'root' })
export class TocService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  save(bookId: number, items: TocEntry[]): Observable<Book> {
    return this.http.put<Book>(`${this.base}/books/${bookId}/toc`, { items });
  }
}
