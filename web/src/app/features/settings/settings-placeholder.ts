import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SettingsSection } from './settings-section';

/** Stand-in for settings sections that later slices build. Copy comes from route data. */
@Component({
  selector: 'ob-settings-placeholder',
  imports: [SettingsSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ob-settings-section [heading]="heading()" [description]="description()" />`,
})
export class SettingsPlaceholder {
  readonly heading = input.required<string>();
  readonly description = input<string>();
}
