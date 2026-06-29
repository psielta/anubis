import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

interface OnlyOfficeDocumentEditor {
  destroyEditor?: () => void;
}

interface OnlyOfficeApi {
  DocEditor: new (elementId: string, config: Record<string, unknown>) => OnlyOfficeDocumentEditor;
}

declare global {
  interface Window {
    DocsAPI?: OnlyOfficeApi;
  }
}

const scriptLoads = new Map<string, Promise<void>>();

function loadOnlyOfficeApi(documentServerUrl: string): Promise<void> {
  const base = documentServerUrl.replace(/\/+$/, '');
  const src = `${base}/web-apps/apps/api/documents/api.js`;
  const existing = scriptLoads.get(src);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const current = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (current && window.DocsAPI) {
      resolve();
      return;
    }
    const script = current ?? document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Nao foi possivel carregar o ONLYOFFICE'));
    if (!current) document.head.appendChild(script);
  });
  scriptLoads.set(src, promise);
  return promise;
}

@Component({
  selector: 'app-onlyoffice-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <div class="onlyoffice-error">{{ error() }}</div>
    }
    <div #host class="onlyoffice-host"></div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 0;
      }

      .onlyoffice-host {
        width: 100%;
        height: 100%;
        min-height: 0;
      }

      .onlyoffice-error {
        padding: 0.75rem;
        color: #8a1f1f;
        background: #fff3f0;
        border-bottom: 1px solid rgba(138, 31, 31, 0.2);
        font-size: 0.86rem;
      }
    `,
  ],
})
export class OnlyOfficeEditor implements AfterViewInit, OnDestroy {
  private zone = inject(NgZone);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  readonly documentServerUrl = input.required<string>();
  readonly config = input.required<Record<string, unknown>>();
  readonly refreshKey = input.required<string | number>();
  readonly loadError = output<string>();

  protected readonly error = signal<string | null>(null);

  private editor: OnlyOfficeDocumentEditor | null = null;
  private mounted = false;
  private renderSeq = 0;
  private readonly hostId = `onlyoffice-${Math.random().toString(36).slice(2)}`;

  constructor() {
    effect(() => {
      const url = this.documentServerUrl();
      const config = this.config();
      this.refreshKey();
      if (!this.mounted || !url || !config) return;
      void this.render(url, config);
    });
  }

  ngAfterViewInit(): void {
    this.mounted = true;
    this.host().nativeElement.id = this.hostId;
    void this.render(this.documentServerUrl(), this.config());
  }

  ngOnDestroy(): void {
    this.destroyEditor();
    this.mounted = false;
  }

  private async render(documentServerUrl: string, config: Record<string, unknown>): Promise<void> {
    const seq = ++this.renderSeq;
    this.error.set(null);
    this.destroyEditor();
    this.host().nativeElement.innerHTML = '';

    try {
      await loadOnlyOfficeApi(documentServerUrl);
      if (seq !== this.renderSeq) return;
      if (!window.DocsAPI) throw new Error('ONLYOFFICE nao ficou disponivel');
      this.zone.runOutsideAngular(() => {
        this.editor = new window.DocsAPI!.DocEditor(this.hostId, config);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nao foi possivel abrir o editor Word';
      this.error.set(message);
      this.loadError.emit(message);
    }
  }

  private destroyEditor(): void {
    try {
      this.editor?.destroyEditor?.();
    } catch {
      // ONLYOFFICE may already have removed its iframe.
    }
    this.editor = null;
  }
}
