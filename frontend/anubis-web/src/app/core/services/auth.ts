import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, finalize, of, switchMap, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AccessToken, LoginRequest, RegisterRequest, User } from '../models/user.model';
import { TokenService } from './token';

const CRED = { withCredentials: true };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private tokens = inject(TokenService);
  private base = environment.apiUrl;

  private readonly _user = signal<User | null>(null);
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this.tokens.accessToken());

  register(data: RegisterRequest): Observable<User> {
    return this.http.post<User>(`${this.base}/auth/register`, data);
  }

  login(data: LoginRequest): Observable<AccessToken> {
    return this.http.post<AccessToken>(`${this.base}/auth/login`, data, CRED).pipe(
      tap((r) => {
        this.tokens.setAccessToken(r.access_token);
        this.loadCurrentUser().subscribe();
      }),
    );
  }

  loadCurrentUser(): Observable<User> {
    return this.http.get<User>(`${this.base}/users/me`).pipe(tap((u) => this._user.set(u)));
  }

  /** Restore user state after reload; refreshes via cookie when access token is missing. */
  bootstrapSession(): Observable<User | null> {
    const fail = () => {
      this.tokens.clear();
      this._user.set(null);
      return of(null);
    };

    const loadUser = () => this.loadCurrentUser().pipe(catchError(() => fail()));

    if (this.tokens.accessToken()) {
      return loadUser();
    }

    return this.refresh().pipe(
      switchMap(() => this.loadCurrentUser()),
      catchError(() => fail()),
    );
  }

  refresh(): Observable<AccessToken> {
    return this.http.post<AccessToken>(`${this.base}/auth/refresh`, {}, CRED).pipe(
      tap((r) => this.tokens.setAccessToken(r.access_token)),
    );
  }

  logout(): void {
    this.http
      .post(`${this.base}/auth/logout`, {}, CRED)
      .pipe(finalize(() => this.finishLogout()))
      .subscribe({ error: () => {} });
  }

  private finishLogout(): void {
    this.tokens.clear();
    this._user.set(null);
    this.router.navigateByUrl('/login');
  }
}