import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../../../core/services/auth';
import { AppLogo } from '../../../shared/app-logo/app-logo';

@Component({
  selector: 'app-register',
  imports: [
    AppLogo,
    ReactiveFormsModule,
    RouterLink,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
  ],
  templateUrl: './register.html',
  styleUrl: './register.scss',
})
export class Register {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected form = this.fb.nonNullable.group({
    full_name: [''],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  submit() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set(null);
    const { full_name, email, password } = this.form.getRawValue();
    this.auth
      .register({ email, password, full_name: full_name || undefined })
      .subscribe({
        next: () => this.router.navigateByUrl('/login'),
        error: (e) => {
          this.error.set(e?.error?.detail ?? 'Registration failed');
          this.loading.set(false);
        },
      });
  }
}