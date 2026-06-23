import { Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { ChunkRead, ChunkSummary } from '../../services/pdf-conversion-api.service';
import { ChunkSidebar } from '../chunk-sidebar/chunk-sidebar';
import { SearchPanel } from '../search-panel/search-panel';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

@Component({
  selector: 'app-markdown-reader',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ChunkSidebar,
    SearchPanel,
  ],
  templateUrl: './markdown-reader.html',
  styleUrl: './markdown-reader.scss',
})
export class MarkdownReader {
  readonly jobId = input.required<string>();
  readonly filename = input.required<string>();
  readonly chunks = input.required<ChunkSummary[]>();
  readonly chunk = input<ChunkRead | null>(null);
  readonly loading = input(false);
  readonly navigate = output<number>();
  readonly copy = output<void>();
  readonly download = output<void>();

  protected readonly activeIndex = computed(() => this.chunk()?.chunk_index ?? 0);
  protected readonly renderedHtml = computed(() => {
    const content = this.chunk()?.content_markdown ?? '';
    if (!content) return '';
    const raw = md.render(content);
    return DOMPurify.sanitize(raw);
  });

  protected readonly canPrev = computed(() => this.activeIndex() > 0);
  protected readonly canNext = computed(
    () => this.activeIndex() < this.chunks().length - 1,
  );

  prev() {
    if (this.canPrev()) this.navigate.emit(this.activeIndex() - 1);
  }

  next() {
    if (this.canNext()) this.navigate.emit(this.activeIndex() + 1);
  }

  openRaw() {
    const content = this.chunk()?.content_markdown ?? '';
    const blob = new Blob([content], { type: 'text/markdown' });
    window.open(URL.createObjectURL(blob), '_blank');
  }
}