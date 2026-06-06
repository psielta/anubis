import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../../core/services/auth';
import { AppLogo } from '../../shared/app-logo/app-logo';

@Component({
  selector: 'app-admin-layout',
  imports: [
    AppLogo,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatSidenavModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
  ],
  templateUrl: './admin-layout.html',
  styleUrl: './admin-layout.scss',
})
export class AdminLayout {
  private auth = inject(AuthService);
  protected readonly user = this.auth.user;
  protected readonly opened = signal(true);

  toggle() {
    this.opened.update((v) => !v);
  }

  logout() {
    this.auth.logout();
  }
}