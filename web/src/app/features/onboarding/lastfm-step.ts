import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { LastfmForm } from '../lastfm/lastfm-form';
import { stepStyles } from './step-styles';

/** Optional last step: a Last.fm key adds a second, preferred source for recommendations. */
@Component({
  selector: 'ob-lastfm-step',
  imports: [LastfmForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [stepStyles],
  template: `
    <div class="intro">
      <h1>Connect Last.fm</h1>
      <p>
        Optional. Offbeat already finds similar artists through ListenBrainz, which needs no setup. A free Last.fm API
        key adds a second source with richer tags, and Offbeat prefers it when present. You can add it later in
        Settings.
      </p>
    </div>
    <ob-lastfm-form submitLabel="Connect and Finish" [allowDisconnect]="false" (saved)="done.emit()">
      <button formAction class="btn btn-ghost" type="button" (click)="done.emit()">Skip for now</button>
    </ob-lastfm-form>
  `,
})
export class LastfmStep {
  readonly done = output();
}
