import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
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
    MatIconModule,
    MatButtonModule,
  ],
  templateUrl: './admin-layout.html',
  styleUrl: './admin-layout.scss',
})
export class AdminLayout {
  private auth = inject(AuthService);
  protected readonly user = this.auth.user;

  logout() {
    this.auth.logout();
  }
}
