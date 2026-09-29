import { CdkDrag, CdkDragHandle, type CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { type QueueSection, type QueueTrack, Player } from '../../core/player';
import { Cover } from '../catalog/cover';
import { formatDuration } from '../format';
import { Icon } from '../icon/icon';
import { PlayingBars } from './playing-bars';

/**
 * The queue (Playing mockup's drawer, and Up Next in Now Playing): the track
 * playing, "Added by you", and "Next from" the album. Rows play when chosen,
 * and reorder by dragging the handle, or from the keyboard: focus a handle
 * and use the up and down arrow keys.
 */
@Component({
  selector: 'ob-queue-list',
  imports: [CdkDropList, CdkDrag, CdkDragHandle, Cover, Icon, PlayingBars],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    section {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .label {
      margin-bottom: 4px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--queue-label, #8e8e95);
    }

    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .current {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px;
      border-radius: 10px;
      background: var(--queue-current, var(--surface-3));

      .art {
        width: 44px;
        border-radius: 5px;
      }

      .title {
        color: var(--accent);
        font-weight: 600;
      }
    }

    li {
      display: flex;
      align-items: center;
      gap: 4px;
      border-radius: 8px;
      background: transparent;

      &:hover {
        background: var(--queue-hover, rgba(255, 255, 255, 0.04));
      }
    }

    .play {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 4px;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      border-radius: 8px;
    }

    .art {
      width: 40px;
      flex-shrink: 0;
    }

    .text {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .title {
      font-size: 14px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .by {
      font-size: 12px;
      color: var(--text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .time {
      font-size: 12px;
      color: var(--text-3);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }

    .handle {
      width: 32px;
      height: 40px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #5e5e65;
      cursor: grab;
      touch-action: none;

      &:hover,
      &:focus-visible {
        color: var(--text-2);
      }
    }

    .empty {
      font-size: 13px;
      color: var(--text-3);
    }

    .cdk-drag-preview {
      display: flex;
      align-items: center;
      border-radius: 8px;
      background: var(--surface-3);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }

    .cdk-drag-placeholder {
      opacity: 0.3;
    }

    .cdk-drop-list-dragging li:not(.cdk-drag-placeholder) {
      transition: transform 180ms ease;
    }
  `,
  template: `
    @if (showCurrent() && player.current(); as current) {
      <section>
        <span class="label">Now Playing</span>
        <div class="current">
          <ob-cover class="art" [src]="current.coverUrl" radius="5px" />
          <span class="text">
            <span class="title">{{ current.title }}</span>
            <span class="by">{{ current.artistName }}</span>
          </span>
          <ob-playing-bars [moving]="player.playing()" />
        </div>
      </section>
    }

    @for (group of groups(); track group.section) {
      <section>
        <span class="label">{{ group.label }}</span>
        <ol cdkDropList [cdkDropListData]="group.section" (cdkDropListDropped)="dropped($event)">
          @for (track of group.tracks; track track.key; let i = $index) {
            <li cdkDrag cdkDragLockAxis="y" cdkDragBoundary="ol" [attr.data-key]="track.key">
              <button class="play" type="button" (click)="player.jumpTo(group.section, i)" [attr.aria-label]="'Play ' + track.title + ' by ' + track.artistName">
                <ob-cover class="art" [src]="track.coverUrl" radius="5px" />
                <span class="text">
                  <span class="title">{{ track.title }}</span>
                  <span class="by">{{ group.section === 'added' ? track.artistName + ', added by you' : track.artistName }}</span>
                </span>
              </button>
              @if (track.durationMs) {
                <span class="time">{{ duration(track) }}</span>
              }
              <button
                class="handle"
                type="button"
                cdkDragHandle
                [attr.aria-label]="'Move ' + track.title + ', ' + (i + 1) + ' of ' + group.tracks.length + '. Use the up and down arrow keys.'"
                (keydown)="keyed($event, group.section, i, group.tracks.length)"
              >
                <ob-icon name="grip" [size]="16" />
              </button>
            </li>
          }
        </ol>
      </section>
    } @empty {
      @if (player.current()) {
        <p class="empty">Nothing is queued after this track.</p>
      }
    }
    <p class="visually-hidden" role="status">{{ announcement() }}</p>
  `,
})
export class QueueList {
  protected readonly player = inject(Player);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The drawer shows the track playing; Now Playing already shows it big. */
  readonly showCurrent = input(true);

  protected readonly announcement = signal('');
  protected readonly groups = computed(() => {
    const groups: { section: QueueSection; label: string; tracks: readonly QueueTrack[] }[] = [];
    if (this.player.added().length) groups.push({ section: 'added', label: 'Added by you', tracks: this.player.added() });
    if (this.player.upNext().length) {
      const from = this.player.context()?.title;
      groups.push({ section: 'upNext', label: from ? `Next from ${from}` : 'Up next', tracks: this.player.upNext() });
    }
    return groups;
  });

  protected duration(track: QueueTrack): string {
    return formatDuration((track.durationMs ?? 0) / 1000);
  }

  protected dropped(event: CdkDragDrop<QueueSection>) {
    this.moveTo(event.container.data, event.previousIndex, event.currentIndex);
  }

  protected keyed(event: KeyboardEvent, section: QueueSection, index: number, count: number) {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= count) return;
    this.moveTo(section, index, to);
  }

  private moveTo(section: QueueSection, from: number, to: number) {
    const list = section === 'added' ? this.player.added() : this.player.upNext();
    const track = list[from];
    if (!track || from === to) return;
    this.player.move(section, from, to);
    this.announcement.set(`${track.title} moved to position ${to + 1} of ${list.length}.`);
    // Moving the row can take focus with it: put it back on the same handle.
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-key="${track.key}"] .handle`)?.focus());
  }
}
