import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth';
import { TokenService } from '../services/token';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const tokens = inject(TokenService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      const isAuthCall = req.url.includes('/auth/');
      if (err.status === 401 && !isAuthCall) {
        return auth.refresh().pipe(
          switchMap(() =>
            next(
              req.clone({
                setHeaders: { Authorization: `Bearer ${tokens.accessToken()}` },
              }),
            ),
          ),
          catchError((e) => {
            auth.logout();
            return throwError(() => e);
          }),
        );
      }
      return throwError(() => err);
    }),
  );
};