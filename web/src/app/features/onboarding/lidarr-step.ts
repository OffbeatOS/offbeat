import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { Session } from '../../core/session';
import { LidarrForm } from '../lidarr/lidarr-form';
import { stepStyles } from './step-styles';

/** Step 2: connect Lidarr and choose defaults for new artists (onboarding mockup). */
@Component({
  selector: 'ob-lidarr-step',
  imports: [LidarrForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [stepStyles],
  template: `
    <div class="intro">
      <h1>Connect Lidarr</h1>
      <p>
        Offbeat adds artists and albums through Lidarr, so it needs to reach your Lidarr server.
        Use the address Offbeat can see from its container, not necessarily the one in your browser.
      </p>
    </div>
    <ob-lidarr-form (saved)="finish()" />
  `,
})
export class LidarrStep {
  private readonly session = inject(Session);
  readonly done = output();

  protected finish() {
    this.session.lidarrConfigured.set(true);
    this.done.emit();
  }
}
