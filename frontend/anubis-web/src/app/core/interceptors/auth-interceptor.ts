import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TokenService } from '../services/token';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(TokenService).accessToken();
  const isAuthCall = req.url.includes('/auth/');
  return token && !isAuthCall
    ? next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }))
    : next(req);
};