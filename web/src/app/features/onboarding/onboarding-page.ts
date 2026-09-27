import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FocusLayout } from '../../shared/focus-layout/focus-layout';
import { AccountStep } from './account-step';
import { StepIndicator } from './step-indicator';

/**
 * First-run wizard. Steps are added here as their slices land (Lidarr next);
 * the indicator appears once there is more than one.
 */
@Component({
  selector: 'ob-onboarding-page',
  imports: [FocusLayout, StepIndicator, AccountStep],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ob-focus-layout>
      @if (steps.length > 1) {
        <ob-step-indicator [steps]="steps" [current]="current()" />
      }
      @switch (currentStep()) {
        @case ('Account') {
          <ob-account-step (done)="next()" />
        }
      }
    </ob-focus-layout>
  `,
})
export class OnboardingPage {
  private readonly router = inject(Router);

  protected readonly steps = ['Account'] as const;
  protected readonly current = signal(0);
  protected readonly currentStep = computed(() => this.steps[this.current()]);

  protected next() {
    if (this.current() < this.steps.length - 1) {
      this.current.update((i) => i + 1);
    } else {
      void this.router.navigateByUrl('/discover');
    }
  }
}
