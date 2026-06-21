import { Directive, NgZone, OnDestroy, inject, input, output } from '@angular/core';
import { ExerciseRegion } from '../../core/models/exercise-resolution.model';

export interface AreaSelection {
  page: number;
  /** Normalized rectangle in [0, 1] of the page box. */
  region: ExerciseRegion;
  /** Viewport (client) coordinates of the rectangle's bottom-left, for a popover. */
  anchor: { x: number; y: number };
}

// Ignore stray clicks / tiny drags so a click never creates an empty crop.
const MIN_SIZE_PX = 8;

/**
 * Rubber-band region capture over the PDF. When ``active``, dragging on a
 * ``.pdf-page`` draws a rectangle and, on release, emits the page number plus a
 * normalized region. The page wrapper is made ``position: relative`` by the
 * ``area-select-active`` host class so the band is positioned within it.
 */
@Directive({
  selector: '[appAreaSelect]',
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '[class.area-select-active]': 'active()',
  },
})
export class AreaSelectDirective implements OnDestroy {
  private readonly zone = inject(NgZone);

  readonly active = input(false);
  readonly regionSelected = output<AreaSelection>();

  private wrap: HTMLElement | null = null;
  private band: HTMLDivElement | null = null;
  private startX = 0;
  private startY = 0;
  private cur = { left: 0, top: 0, w: 0, h: 0 };
  private pointerId: number | null = null;
  private moveHandler: ((e: PointerEvent) => void) | null = null;
  private endHandler: ((e: PointerEvent) => void) | null = null;

  ngOnDestroy() {
    this.cleanup();
  }

  onPointerDown(e: PointerEvent) {
    if (!this.active() || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    const wrap = target?.closest<HTMLElement>('.pdf-page');
    if (!wrap) return;
    e.preventDefault();

    this.wrap = wrap;
    const rect = wrap.getBoundingClientRect();
    this.startX = this.clamp(e.clientX - rect.left, rect.width);
    this.startY = this.clamp(e.clientY - rect.top, rect.height);
    this.cur = { left: this.startX, top: this.startY, w: 0, h: 0 };

    const band = document.createElement('div');
    band.className = 'crop-rubberband';
    this.applyBand(band);
    wrap.appendChild(band);
    this.band = band;

    this.pointerId = e.pointerId;
    try {
      wrap.setPointerCapture?.(e.pointerId);
    } catch {
      // Capturing can fail for untrusted/synthetic pointers; the window
      // listeners below still complete the drag.
    }

    this.moveHandler = (ev: PointerEvent) => this.onMove(ev);
    this.endHandler = () => this.onEnd();
    this.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', this.moveHandler!);
      window.addEventListener('pointerup', this.endHandler!);
      window.addEventListener('pointercancel', this.endHandler!);
    });
  }

  private onMove(e: PointerEvent) {
    if (!this.wrap || !this.band) return;
    const rect = this.wrap.getBoundingClientRect();
    const curX = this.clamp(e.clientX - rect.left, rect.width);
    const curY = this.clamp(e.clientY - rect.top, rect.height);
    this.cur = {
      left: Math.min(this.startX, curX),
      top: Math.min(this.startY, curY),
      w: Math.abs(curX - this.startX),
      h: Math.abs(curY - this.startY),
    };
    this.applyBand(this.band);
  }

  private onEnd() {
    const wrap = this.wrap;
    const band = this.band;
    this.detachListeners();
    if (wrap && this.pointerId != null) {
      try {
        wrap.releasePointerCapture?.(this.pointerId);
      } catch {
        // No capture was held.
      }
    }
    this.pointerId = null;
    this.band = null;
    this.wrap = null;
    band?.remove();
    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const { left, top, w, h } = this.cur;
    if (w < MIN_SIZE_PX || h < MIN_SIZE_PX || rect.width === 0 || rect.height === 0) {
      return;
    }
    const page = Number(wrap.dataset['page']);
    if (!Number.isFinite(page) || page < 1) return;

    const region: ExerciseRegion = {
      x0: left / rect.width,
      y0: top / rect.height,
      x1: (left + w) / rect.width,
      y1: (top + h) / rect.height,
    };
    const anchor = { x: rect.left + left, y: rect.top + top + h };
    this.zone.run(() => this.regionSelected.emit({ page, region, anchor }));
  }

  private applyBand(band: HTMLDivElement) {
    band.style.left = `${this.cur.left}px`;
    band.style.top = `${this.cur.top}px`;
    band.style.width = `${this.cur.w}px`;
    band.style.height = `${this.cur.h}px`;
  }

  private clamp(value: number, max: number): number {
    return Math.max(0, Math.min(max, value));
  }

  private detachListeners() {
    if (this.moveHandler) {
      window.removeEventListener('pointermove', this.moveHandler);
      this.moveHandler = null;
    }
    if (this.endHandler) {
      window.removeEventListener('pointerup', this.endHandler);
      window.removeEventListener('pointercancel', this.endHandler);
      this.endHandler = null;
    }
  }

  private cleanup() {
    this.detachListeners();
    this.band?.remove();
    this.band = null;
    this.wrap = null;
    this.pointerId = null;
  }
}
