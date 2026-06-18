import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private snack = inject(MatSnackBar);

  success(message: string) {
    this.open(message, 2600);
  }

  error(message: string) {
    this.open(message, 5200);
  }

  private open(message: string, duration: number) {
    this.snack.open(message, 'OK', {
      duration,
      horizontalPosition: 'right',
      verticalPosition: 'bottom',
    });
  }
}
