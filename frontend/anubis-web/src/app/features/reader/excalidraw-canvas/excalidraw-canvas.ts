import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';

// Excalidraw's onChange fires on every pointer move; persist on a pause instead.
const SCENE_DEBOUNCE_MS = 1500;

/**
 * Mounts the Excalidraw React component inside Angular. The drawing is opaque to
 * the rest of the app: it comes in as a serialized JSON string (`initialScene`)
 * and is emitted back out as one (`sceneChange`). `getScene()` lets the parent
 * grab the latest scene synchronously when saving, bypassing the debounce.
 */
@Component({
  selector: 'app-excalidraw-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="excalidraw-host"></div>`,
  styles: [
    `
      :host,
      .excalidraw-host {
        display: block;
        width: 100%;
        height: 100%;
      }
      .excalidraw-host {
        position: relative;
      }
    `,
  ],
})
export class ExcalidrawCanvas implements AfterViewInit, OnDestroy {
  private zone = inject(NgZone);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  /** Serialized scene JSON from the DB, or null for a blank canvas. */
  readonly initialScene = input<string | null>(null);
  /** Debounced serialized scene to persist; the parent saves the string verbatim. */
  readonly sceneChange = output<string>();

  private root: ReactDOMClient.Root | null = null;
  private api: ExcalidrawImperativeAPI | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    const initialData = this.parseInitial(this.initialScene());
    // Keep Excalidraw's continuous render loop out of Angular's zone so it does
    // not trigger change detection on every frame.
    this.zone.runOutsideAngular(() => {
      this.root = ReactDOMClient.createRoot(this.host().nativeElement);
      this.root.render(
        React.createElement(Excalidraw, {
          initialData,
          onChange: () => this.scheduleEmit(),
          excalidrawAPI: (api: ExcalidrawImperativeAPI) => {
            this.api = api;
          },
        }),
      );
    });
  }

  ngOnDestroy(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.root?.unmount();
    this.root = null;
    this.api = null;
  }

  /** Latest scene as JSON, read straight from the live editor. */
  getScene(): string | null {
    if (!this.api) return null;
    return serializeAsJSON(
      this.api.getSceneElements(),
      this.api.getAppState(),
      this.api.getFiles(),
      'local',
    );
  }

  private scheduleEmit(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const json = this.getScene();
      if (json != null) this.zone.run(() => this.sceneChange.emit(json));
    }, SCENE_DEBOUNCE_MS);
  }

  private parseInitial(raw: string | null): ExcalidrawInitialDataState | null {
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as {
        elements?: ExcalidrawInitialDataState['elements'];
        appState?: Partial<AppState>;
        files?: ExcalidrawInitialDataState['files'];
      };
      return {
        elements: data.elements ?? [],
        appState: data.appState ?? {},
        files: data.files ?? undefined,
        scrollToContent: true,
      };
    } catch {
      return null;
    }
  }
}
