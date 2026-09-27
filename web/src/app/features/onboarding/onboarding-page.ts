import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Session } from '../../core/session';
import { FocusLayout } from '../../shared/focus-layout/focus-layout';
import { AccountStep } from './account-step';
import { LidarrStep } from './lidarr-step';
import { StepIndicator } from './step-indicator';

const STEPS = ['Account', 'Lidarr'] as const;

/**
 * First-run wizard. It resumes at the first unfinished step, so an admin who
 * left before connecting Lidarr comes back to that step. More steps are added
 * as their slices land.
 */
@Component({
  selector: 'ob-onboarding-page',
  imports: [FocusLayout, StepIndicator, AccountStep, LidarrStep],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ob-focus-layout>
      <ob-step-indicator [steps]="steps" [current]="current()" />
      @switch (currentStep()) {
        @case ('Account') {
          <ob-account-step (done)="next()" />
        }
        @case ('Lidarr') {
          <ob-lidarr-step (done)="next()" />
        }
      }
    </ob-focus-layout>
  `,
})
export class OnboardingPage {
  private readonly router = inject(Router);

  protected readonly steps = STEPS;
  protected readonly current = signal(inject(Session).needsAdmin() ? 0 : 1);
  protected readonly currentStep = computed(() => this.steps[this.current()]);

  protected next() {
    if (this.current() < this.steps.length - 1) {
      this.current.update((i) => i + 1);
    } else {
      void this.router.navigateByUrl('/discover');
    }
  }
}
