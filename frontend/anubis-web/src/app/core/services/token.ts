import { Injectable, signal } from '@angular/core';

const ACCESS = 'anubis_access';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private readonly _access = signal<string | null>(localStorage.getItem(ACCESS));
  readonly accessToken = this._access.asReadonly();

  setAccessToken(token: string) {
    this._access.set(token);
    localStorage.setItem(ACCESS, token);
  }

  clear() {
    this._access.set(null);
    localStorage.removeItem(ACCESS);
  }
}