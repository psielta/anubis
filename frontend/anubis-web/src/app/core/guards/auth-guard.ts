import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../services/auth';

export const authGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = inject(AuthService);

  const user = await firstValueFrom(auth.bootstrapSession());

  if (user) {
    return true;
  }

  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};