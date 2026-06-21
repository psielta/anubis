import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  viewChild,
} from '@angular/core';

const RENDER_DEBOUNCE_MS = 250;

/**
 * Renders a live SVG preview of a Mermaid definition. Mermaid is loaded lazily
 * (its own chunk) on first use and runs with `securityLevel: 'strict'` so
 * user-authored definitions cannot inject scripts.
 */
@Component({
  selector: 'app-mermaid-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="mermaid-host"></div>`,
  styles: [
    `
      :host {
        display: block;
        overflow: auto;
      }
      .mermaid-host {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        min-height: 100%;
      }
      .mermaid-host svg {
        max-width: 100%;
        height: auto;
      }
      .mermaid-error {
        margin: 0;
        align-self: center;
        font-size: 0.85rem;
        color: var(--anubis-ink-soft);
      }
    `,
  ],
})
export class MermaidPreview implements OnDestroy {
  readonly source = input<string>('');

  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private mermaidPromise?: Promise<(typeof import('mermaid'))['default']>;

  constructor() {
    effect(() => {
      const src = this.source();
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.render(src), RENDER_DEBOUNCE_MS);
    });
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
    if (!this.mermaidPromise) {
      this.mermaidPromise = import('mermaid').then((m) => {
        m.default.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'strict',
        });
        return m.default;
      });
    }
    return this.mermaidPromise;
  }

  private async render(src: string): Promise<void> {
    const token = ++this.seq;
    const el = this.host().nativeElement;
    const code = src.trim();
    if (!code) {
      el.replaceChildren();
      return;
    }
    try {
      const mermaid = await this.loadMermaid();
      const valid = await mermaid.parse(code, { suppressErrors: true });
      if (token !== this.seq) return; // a newer edit superseded this render
      if (!valid) {
        this.showError(el, 'Sintaxe de diagrama inválida');
        return;
      }
      const { svg } = await mermaid.render(`dg-mermaid-${token}`, code);
      if (token !== this.seq) return;
      el.innerHTML = svg;
    } catch {
      if (token === this.seq) this.showError(el, 'Não foi possível renderizar este diagrama');
    }
  }

  private showError(el: HTMLElement, message: string): void {
    const p = document.createElement('p');
    p.className = 'mermaid-error';
    p.textContent = message;
    el.replaceChildren(p);
  }
}
