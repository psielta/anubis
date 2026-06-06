import { Component, input } from '@angular/core';

@Component({
  selector: 'app-logo',
  templateUrl: './app-logo.html',
  styleUrl: './app-logo.scss',
})
export class AppLogo {
  readonly showLabel = input(true);
  readonly size = input<'sm' | 'md' | 'lg'>('md');
}