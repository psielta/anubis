import { ScrollingModule } from '@angular/cdk/scrolling';
import { Component, input, output } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { ChunkSummary } from '../../services/pdf-conversion-api.service';

@Component({
  selector: 'app-chunk-sidebar',
  imports: [MatListModule, ScrollingModule],
  templateUrl: './chunk-sidebar.html',
  styleUrl: './chunk-sidebar.scss',
})
export class ChunkSidebar {
  readonly chunks = input.required<ChunkSummary[]>();
  readonly activeIndex = input.required<number>();
  readonly selectChunk = output<number>();
}