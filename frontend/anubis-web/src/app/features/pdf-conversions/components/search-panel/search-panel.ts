import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { PdfConversionApiService, SearchHit } from '../../services/pdf-conversion-api.service';

@Component({
  selector: 'app-search-panel',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
  ],
  templateUrl: './search-panel.html',
  styleUrl: './search-panel.scss',
})
export class SearchPanel {
  private api = inject(PdfConversionApiService);

  readonly jobId = input.required<string>();
  readonly selectChunk = output<number>();

  protected query = '';
  protected hits = signal<SearchHit[]>([]);
  protected searching = signal(false);
  protected error = signal<string | null>(null);

  search() {
    const q = this.query.trim();
    if (!q) return;
    this.searching.set(true);
    this.error.set(null);
    this.api.search(this.jobId(), q).subscribe({
      next: (res) => {
        this.hits.set(res.hits);
        this.searching.set(false);
      },
      error: () => {
        this.error.set('Busca falhou');
        this.searching.set(false);
      },
    });
  }
}