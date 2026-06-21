import { Injectable, signal } from '@angular/core';

const PANEL_WIDTH = 'anubis_reader_panel_width';
const AUTO_TRANSLATE = 'anubis_reader_auto_translate';
const DEFAULT_PANEL_WIDTH = 400;
const MIN_PANEL_WIDTH = 320;

@Injectable({ providedIn: 'root' })
export class ReaderPrefsService {
  private readonly _panelWidth = signal(this.read());
  readonly panelWidth = this._panelWidth.asReadonly();

  private readonly _autoTranslate = signal(this.readAutoTranslate());
  readonly autoTranslate = this._autoTranslate.asReadonly();

  setPanelWidth(width: number) {
    const w = Math.max(MIN_PANEL_WIDTH, Math.round(width));
    this._panelWidth.set(w);
    localStorage.setItem(PANEL_WIDTH, String(w));
  }

  setAutoTranslate(on: boolean) {
    this._autoTranslate.set(on);
    localStorage.setItem(AUTO_TRANSLATE, on ? '1' : '0');
  }

  private read(): number {
    const raw = Number(localStorage.getItem(PANEL_WIDTH));
    return Number.isFinite(raw) && raw >= MIN_PANEL_WIDTH ? raw : DEFAULT_PANEL_WIDTH;
  }

  private readAutoTranslate(): boolean {
    return localStorage.getItem(AUTO_TRANSLATE) === '1';
  }
}