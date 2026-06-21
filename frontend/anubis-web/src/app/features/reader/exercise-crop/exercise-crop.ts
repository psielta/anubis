import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { ExerciseRegion } from '../../../core/models/exercise-resolution.model';

/**
 * Renders the cropped statement region straight from the PDF. Reuses the same
 * pdf.js render path as the reader (getPage → getViewport → page.render) but
 * passes a translate ``transform`` so only the region paints into a small,
 * memory-bounded canvas — no full-page raster regardless of how small the crop.
 */
@Component({
  selector: 'app-exercise-crop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas class="exercise-crop-canvas"></canvas>`,
  styles: [
    `
      :host {
        display: block;
      }
      .exercise-crop-canvas {
        display: block;
        max-width: 100%;
      }
    `,
  ],
})
export class ExerciseCrop {
  readonly pdfDoc = input<PDFDocumentProxy | null>(null);
  readonly page = input<number>(0);
  readonly region = input<ExerciseRegion | null>(null);
  readonly maxWidth = input<number>(320);

  private canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private generation = 0;
  private task: RenderTask | null = null;

  constructor() {
    effect(() => {
      const doc = this.pdfDoc();
      const page = this.page();
      const region = this.region();
      const maxWidth = this.maxWidth();
      // Read the view child reactively so the first render waits for the canvas.
      const canvas = this.canvasRef()?.nativeElement;
      if (!canvas) return;
      void this.render(canvas, doc, page, region, maxWidth);
    });
  }

  private async render(
    canvas: HTMLCanvasElement,
    doc: PDFDocumentProxy | null,
    page: number,
    region: ExerciseRegion | null,
    maxWidth: number,
  ) {
    const generation = ++this.generation;
    try {
      this.task?.cancel();
    } catch {
      /* a settled task ignores cancel */
    }
    this.task = null;
    if (!doc || !page || page < 1 || !region) return;

    const p = await doc.getPage(page);
    if (generation !== this.generation) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const quality = Math.min(window.devicePixelRatio || 1, 2);
    const base = p.getViewport({ scale: 1 });
    const regionWpdf = Math.max(1, (region.x1 - region.x0) * base.width);
    const displayScale = Math.max(0.1, maxWidth / regionWpdf);
    const renderScale = Math.min(displayScale * quality, 8);
    const vp = p.getViewport({ scale: renderScale });

    const sx = region.x0 * vp.width;
    const sy = region.y0 * vp.height;
    const sw = Math.max(1, Math.floor((region.x1 - region.x0) * vp.width));
    const sh = Math.max(1, Math.floor((region.y1 - region.y0) * vp.height));

    canvas.width = sw;
    canvas.height = sh;
    canvas.style.width = `${Math.round(sw / quality)}px`;
    canvas.style.height = `${Math.round(sh / quality)}px`;

    const task = p.render({
      canvas,
      canvasContext: ctx,
      viewport: vp,
      transform: [1, 0, 0, 1, -sx, -sy],
    });
    this.task = task;
    try {
      await task.promise;
    } catch {
      /* cancelled by a newer render */
    }
  }
}
