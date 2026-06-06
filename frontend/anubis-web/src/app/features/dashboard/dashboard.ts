import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../core/services/auth';
import { LibraryService } from '../../core/services/library';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, MatButtonModule, MatIconModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private library = inject(LibraryService);

  protected readonly user = inject(AuthService).user;
  protected readonly bookCount = signal<number | null>(null);

  ngOnInit() {
    this.library.list({ pageSize: 1 }).subscribe({
      next: (page) => this.bookCount.set(page.total),
      error: () => this.bookCount.set(null),
    });
  }
}
