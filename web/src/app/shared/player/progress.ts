import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Player } from '../../core/player';
import { formatDuration } from '../format';
import { Range } from './range';

/**
 * Where the track is, and seeking (Playing and Now Playing mockups): the
 * time played and the time left either side of the bar, or under a larger
 * bar with a thumb in Now Playing.
 */
@Component({
  selector: 'ob-progress',
  imports: [Range],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.large]': "size() === 'large'" },
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
    }

    .time {
      width: 38px;
      flex-shrink: 0;
      font-size: 11px;
      color: var(--text-3);
      font-variant-numeric: tabular-nums;
    }

    .played {
      text-align: right;
    }

    ob-range {
      flex-grow: 1;
    }

    :host(.large) {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 0;

      ob-range {
        grid-column: 1 / -1;
        --range-height: 5px;
        --range-track: rgba(255, 255, 255, 0.14);
      }

      .time {
        width: auto;
        font-size: 12px;
        color: var(--tint-text, var(--text-3));
      }

      .played {
        grid-row: 2;
        text-align: left;
      }

      .left {
        grid-row: 2;
        text-align: right;
      }
    }
  `,
  template: `
    <span class="time played">{{ played() }}</span>
    <ob-range
      [class.thumb]="size() === 'large'"
      [value]="player.position()"
      [max]="player.duration() || 1"
      [disabled]="!player.duration()"
      label="Seek"
      [valueText]="played() + ' of ' + total()"
      (dragging)="dragged.set($event)"
      (changed)="player.seek($event)"
    />
    <span class="time left">-{{ left() }}</span>
  `,
})
export class Progress {
  protected readonly player = inject(Player);
  readonly size = input<'bar' | 'large'>('bar');

  /** Where the thumb is while dragging, so the clock follows it. */
  protected readonly dragged = signal<number | null>(null);
  private readonly at = computed(() => this.dragged() ?? this.player.position());
  protected readonly played = computed(() => formatDuration(this.at()));
  protected readonly left = computed(() => formatDuration(Math.max(0, this.player.duration() - this.at())));
  protected readonly total = computed(() => formatDuration(this.player.duration()));
}
