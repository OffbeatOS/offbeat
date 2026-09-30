import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Player } from '../../core/player';
import { Icon } from '../icon/icon';

/**
 * Shuffle, previous, play or pause, next, and repeat (Playing and Now
 * Playing mockups). `size` picks the bar's or Now Playing's scale.
 */
@Component({
  selector: 'ob-transport',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.large]': "size() === 'large'" },
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 22px;
    }

    :host(.large) {
      justify-content: space-between;
      gap: 0;
    }

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      color: var(--text);
      padding: 0;
      border-radius: 50%;
    }

    .mode {
      width: 32px;
      height: 32px;
      color: var(--transport-muted, var(--text-3));
      position: relative;

      &[aria-pressed='true'] {
        color: var(--accent);
      }

      &[aria-pressed='true']::after {
        content: '';
        position: absolute;
        bottom: 1px;
        left: 50%;
        width: 4px;
        height: 4px;
        margin-left: -2px;
        border-radius: 50%;
        background: var(--accent);
      }
    }

    .skip {
      width: 36px;
      height: 36px;
    }

    .main {
      width: 40px;
      height: 40px;
      background: var(--text);
      color: var(--bg);

      &:hover {
        transform: scale(1.04);
      }
    }

    :host(.large) {
      .mode {
        width: 44px;
        height: 44px;
      }

      .skip {
        width: 52px;
        height: 52px;
      }

      .main {
        width: 72px;
        height: 72px;
      }
    }

    @media (max-width: 768px) {
      :host(.large) .main {
        width: 76px;
        height: 76px;
      }
    }
  `,
  template: `
    <button class="mode" type="button" aria-label="Shuffle" [attr.aria-pressed]="player.shuffle()" (click)="player.toggleShuffle()">
      <ob-icon name="shuffle" [size]="large() ? 22 : 18" />
    </button>
    <button class="skip" type="button" aria-label="Previous" (click)="player.previous()">
      <ob-icon name="previous" [size]="large() ? 30 : 20" />
    </button>
    <button class="main" type="button" [attr.aria-label]="player.playing() ? 'Pause' : 'Play'" (click)="player.toggle()">
      <ob-icon [name]="player.playing() ? 'pause' : 'play'" [size]="large() ? 30 : 18" />
    </button>
    <button class="skip" type="button" aria-label="Next" (click)="player.next()">
      <ob-icon name="next" [size]="large() ? 30 : 20" />
    </button>
    <button
      class="mode"
      type="button"
      [attr.aria-label]="player.repeat() === 'one' ? 'Repeat this track' : 'Repeat'"
      [attr.aria-pressed]="player.repeat() !== 'off'"
      (click)="player.cycleRepeat()"
    >
      <ob-icon [name]="player.repeat() === 'one' ? 'repeat-one' : 'repeat'" [size]="large() ? 22 : 18" />
    </button>
  `,
})
export class Transport {
  protected readonly player = inject(Player);
  readonly size = input<'bar' | 'large'>('bar');
  protected readonly large = computed(() => this.size() === 'large');
}
