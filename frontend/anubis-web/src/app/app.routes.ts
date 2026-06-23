import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth-guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login').then((m) => m.Login),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/auth/register/register').then((m) => m.Register),
  },
  {
    path: 'read/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./features/reader/reader').then((m) => m.Reader),
  },
  {
    path: '',
    loadComponent: () => import('./layout/admin-layout/admin-layout').then((m) => m.AdminLayout),
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'library/series/:id',
        loadComponent: () =>
          import('./features/library/series-detail/series-detail').then((m) => m.SeriesDetail),
      },
      {
        path: 'library/series',
        loadComponent: () =>
          import('./features/library/series-library/series-library').then(
            (m) => m.SeriesLibrary,
          ),
      },
      {
        path: 'library',
        loadComponent: () => import('./features/library/library').then((m) => m.Library),
      },
      {
        path: 'pdf-conversions/upload',
        loadComponent: () =>
          import('./features/pdf-conversions/pages/upload-page/upload-page').then(
            (m) => m.UploadPage,
          ),
      },
      {
        path: 'pdf-conversions/:id/read',
        loadComponent: () =>
          import(
            './features/pdf-conversions/pages/markdown-reader-page/markdown-reader-page'
          ).then((m) => m.MarkdownReaderPage),
      },
      {
        path: 'pdf-conversions/:id',
        loadComponent: () =>
          import('./features/pdf-conversions/pages/job-progress-page/job-progress-page').then(
            (m) => m.JobProgressPage,
          ),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
