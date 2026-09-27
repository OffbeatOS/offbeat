import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActivityStore } from '../../core/activity-store';
import { STATE_LABEL, percent } from '../catalog/activity-labels';
import { Cover } from '../catalog/cover';
import { Icon } from '../icon/icon';

/**
 * Persistent bar below the router outlet (Main mockup). Shows live download
 * activity until phase 5 turns it into the player, which is why it lives in
 * the shell rather than inside any routed page. On mobile it becomes the
 * floating mini bar above the tab bar, and hides while idle.
 */
@Component({
  selector: 'ob-bottom-bar',
  imports: [RouterLink, Cover, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './bottom-bar.scss',
  template: `
    <div class="bar" [class.active]="!!item()">
      @if (item(); as item) {
        <a class="now" routerLink="/activity">
          <ob-cover class="art" [src]="item.coverUrl" radius="6px" />
          <span class="text">
            <span class="row">
              <span class="title">{{ item.albumTitle }}</span>
              <span class="value">{{ value() }}</span>
            </span>
            <span class="track"><span class="fill" [style.width.%]="fill()"></span></span>
            <span class="caption">{{ caption() }}</span>
          </span>
        </a>
      } @else {
        <span class="idle">No downloads in progress</span>
      }
      <span class="right">
        @if (attention(); as count) {
          <a class="attention" routerLink="/activity">
            <ob-icon name="alert" [size]="16" [strokeWidth]="2" />{{ count }} {{ count === 1 ? 'needs' : 'need' }} attention
          </a>
        }
        <a class="link" routerLink="/activity">View activity</a>
      </span>
    </div>
  `,
})
export class BottomBar {
  private readonly store = inject(ActivityStore);

  protected readonly item = computed(() => this.store.current().item);
  protected readonly attention = computed(() => this.store.current().attention);

  /** Percentage while downloading, otherwise the state. */
  protected readonly value = computed(() => {
    const item = this.item();
    if (!item) return '';
    return item.state === 'downloading' ? percent(item.progress) : STATE_LABEL[item.state];
  });

  protected readonly fill = computed(() => {
    const item = this.item();
    if (!item) return 0;
    if (item.state === 'importing') return 100;
    return Math.round((item.progress ?? 0) * 100);
  });

  /** "Downloading, 1 more in queue" */
  protected readonly caption = computed(() => {
    const { item, more } = this.store.current();
    if (!item) return '';
    const label = STATE_LABEL[item.state];
    return more ? `${label}, ${more} more in queue` : label;
  });
}
