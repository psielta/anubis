import {
  Directive,
  ElementRef,
  NgZone,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

@Directive({
  selector: '[appPanelResizer]',
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(keydown)': 'onKeyDown($event)',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'maxPx()',
    '[attr.aria-valuenow]': 'now()',
  },
})
export class PanelResizerDirective implements OnDestroy {
  private readonly zone = inject(NgZone);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly resizeTarget = input.required<HTMLElement>();
  readonly min = input(320);
  readonly readingMin = input(360);
  readonly step = input(24);
  readonly initial = input(0);
  readonly resizeEnd = output<number>();

  readonly now = signal(0);
  /** Kept fresh via ResizeObserver for aria-valuemax; clamp reads live geometry. */
  readonly maxPx = signal(0);

  private moveHandler: ((e: PointerEvent) => void) | null = null;
  private endHandler: ((e: PointerEvent) => void) | null = null;
  private capturedPointerId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      this.now.set(this.initial());
    });

    effect((onCleanup) => {
      const el = this.resizeTarget();
      this.maxPx.set(this.computeMaxAllowed(el));
      const observer = new ResizeObserver(() => {
        this.zone.run(() => this.maxPx.set(this.computeMaxAllowed(el)));
      });
      observer.observe(el);
      this.resizeObserver = observer;
      onCleanup(() => {
        observer.disconnect();
        this.resizeObserver = null;
      });
    });
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detachListeners();
  }

  onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();

    const target = this.resizeTarget();
    const grabber = this.host.nativeElement;
    grabber.setPointerCapture(e.pointerId);
    this.capturedPointerId = e.pointerId;

    target.classList.add('resizing');
    let current = this.readCurrentWidth(target);

    this.moveHandler = (ev: PointerEvent) => {
      const rect = target.getBoundingClientRect();
      const width = this.clamp(rect.right - ev.clientX, target);
      target.style.setProperty('--dg-user-panel-w', `${width}px`);
      current = width;
    };

    this.endHandler = () => {
      this.finishDrag(grabber, target, current);
    };

    this.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', this.moveHandler!);
      window.addEventListener('pointerup', this.endHandler!);
      window.addEventListener('pointercancel', this.endHandler!);
    });
  }

  onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();

    const target = this.resizeTarget();
    const delta = e.key === 'ArrowLeft' ? this.step() : -this.step();
    const width = this.clamp(this.now() + delta, target);
    target.style.setProperty('--dg-user-panel-w', `${width}px`);
    this.now.set(width);
    this.zone.run(() => this.resizeEnd.emit(width));
  }

  private finishDrag(grabber: HTMLElement, target: HTMLElement, current: number) {
    this.detachListeners();
    if (this.capturedPointerId != null) {
      grabber.releasePointerCapture(this.capturedPointerId);
      this.capturedPointerId = null;
    }
    target.classList.remove('resizing');
    this.now.set(current);
    this.zone.run(() => this.resizeEnd.emit(current));
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

  private computeMaxAllowed(target: HTMLElement): number {
    const w = target.getBoundingClientRect().width;
    return Math.min(w - this.readingMin(), w * 0.9);
  }

  private clamp(width: number, target: HTMLElement): number {
    return Math.round(Math.max(this.min(), Math.min(this.computeMaxAllowed(target), width)));
  }

  private readCurrentWidth(target: HTMLElement): number {
    const inline = target.style.getPropertyValue('--dg-user-panel-w').trim();
    if (inline) {
      const parsed = parseFloat(inline);
      if (Number.isFinite(parsed)) return parsed;
    }
    const computed = getComputedStyle(target).getPropertyValue('--dg-user-panel-w').trim();
    if (computed) {
      const parsed = parseFloat(computed);
      if (Number.isFinite(parsed)) return parsed;
    }
    return this.initial();
  }
}