import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Player } from '../../core/player';
import { Cover } from '../catalog/cover';
import { Icon } from '../icon/icon';
import { Progress } from '../player/progress';
import { Range } from '../player/range';
import { Transport } from '../player/transport';

/**
 * The bottom bar once something is queued (Playing mockup): the track, the
 * transport and progress, then the queue, volume, and Now Playing. On a
 * phone it is the mini player floating above the tab bar (MobilePlaying
 * mockup), with a thin progress line; tapping it opens Now Playing.
 */
@Component({
  selector: 'ob-player-bar',
  imports: [RouterLink, Cover, Icon, Progress, Range, Transport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    @use '../mixins';

    :host {
      display: block;
    }

    .bar {
      height: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 560px) minmax(0, 1fr);
      align-items: center;
      gap: 24px;
      padding: 0 24px;
      background: var(--bg-bar);
      border-top: 1px solid var(--border-bar);
    }

    .now {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .art-button {
      width: 52px;
      flex-shrink: 0;
      padding: 0;
      border: 0;
      background: transparent;
      border-radius: 6px;
    }

    .titles {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .title {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      font-size: 14px;
      font-weight: 600;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .artist {
      font-size: 13px;
      color: var(--text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      &:hover {
        color: var(--text);
      }
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .center {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }

    .right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 14px;
    }

    .icon-button {
      width: 34px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--text-2);

      &:hover {
        color: var(--text);
      }

      &[aria-pressed='true'] {
        color: var(--accent);
      }
    }

    .volume {
      display: flex;
      align-items: center;
      gap: 4px;

      ob-range {
        width: 96px;
        --range-fill: var(--text-2);
      }
    }

    .mini {
      display: none;
    }

    @include mixins.mobile {
      :host {
        position: fixed;
        left: 8px;
        right: 8px;
        bottom: calc(var(--tab-bar-height) + env(safe-area-inset-bottom) + 8px);
        z-index: 9;
      }

      .bar {
        display: none;
      }

      .mini {
        position: relative;
        height: 62px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 8px 0 10px;
        border-radius: 12px;
        background: var(--surface-3);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        overflow: hidden;
      }

      .line {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 2px;
        background: rgba(255, 255, 255, 0.1);

        span {
          display: block;
          height: 2px;
          background: var(--text);
        }
      }

      .open {
        flex-grow: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
      }

      .mini .art {
        width: 42px;
        flex-shrink: 0;
      }

      .mini .titles .by {
        font-size: 12px;
        color: var(--text-3);
      }

      .mini .titles .name {
        font-size: 14px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mini .icon-button {
        width: 44px;
        height: 44px;
        color: var(--text);
      }
    }
  `,
  template: `
    @if (player.current(); as track) {
      <footer class="bar" aria-label="Player">
        <div class="now">
          <button class="art-button" type="button" aria-label="Open Now Playing" (click)="player.nowPlayingOpen.set(true)">
            <ob-cover [src]="track.coverUrl" radius="6px" />
          </button>
          <div class="titles">
            <button class="title" type="button" (click)="player.nowPlayingOpen.set(true)">{{ track.title }}</button>
            @if (player.error(); as error) {
              <span class="error" role="alert">{{ error }}</span>
            } @else {
              <a class="artist" [routerLink]="['/artist', track.artistMbid]">{{ track.artistName }}</a>
            }
          </div>
        </div>
        <div class="center">
          <ob-transport />
          <ob-progress />
        </div>
        <div class="right">
          <button class="icon-button" type="button" aria-label="Queue" [attr.aria-pressed]="player.queueOpen()" (click)="player.queueOpen.set(!player.queueOpen())">
            <ob-icon name="queue" [size]="20" />
          </button>
          <span class="volume">
            <button class="icon-button" type="button" [attr.aria-label]="muted() ? 'Unmute' : 'Mute'" (click)="toggleMute()">
              <ob-icon [name]="muted() ? 'volume-off' : 'volume'" [size]="20" />
            </button>
            <ob-range [value]="player.volume()" [max]="1" [step]="0.01" label="Volume" [valueText]="volumeText()" (changed)="player.setVolume($event)" (dragging)="dragVolume($event)" />
          </span>
          <button class="icon-button" type="button" aria-label="Open Now Playing" (click)="player.nowPlayingOpen.set(true)">
            <ob-icon name="expand" [size]="18" />
          </button>
        </div>
      </footer>

      <div class="mini" aria-label="Player" role="region">
        <button class="open" type="button" aria-label="Open Now Playing" (click)="player.nowPlayingOpen.set(true)">
          <ob-cover class="art" [src]="track.coverUrl" radius="6px" />
          <span class="titles">
            <span class="name">{{ track.title }}</span>
            <span class="by" [class.error]="!!player.error()">{{ player.error() || track.artistName }}</span>
          </span>
        </button>
        <button class="icon-button" type="button" [attr.aria-label]="player.playing() ? 'Pause' : 'Play'" (click)="player.toggle()">
          <ob-icon [name]="player.playing() ? 'pause' : 'play'" [size]="22" />
        </button>
        <button class="icon-button" type="button" aria-label="Next" (click)="player.next()">
          <ob-icon name="next" [size]="22" />
        </button>
        <span class="line" aria-hidden="true"><span [style.width.%]="fill()"></span></span>
      </div>
    }
  `,
})
export class PlayerBar {
  protected readonly player = inject(Player);
  /** The volume before muting, to come back to. */
  private unmuted = 1;

  protected readonly muted = computed(() => this.player.volume() === 0);
  protected readonly volumeText = computed(() => `${Math.round(this.player.volume() * 100)}%`);
  protected readonly fill = computed(() => {
    const duration = this.player.duration();
    return duration ? Math.min(100, (this.player.position() / duration) * 100) : 0;
  });

  protected toggleMute() {
    if (this.muted()) {
      this.player.setVolume(this.unmuted || 1);
    } else {
      this.unmuted = this.player.volume();
      this.player.setVolume(0);
    }
  }

  /** Volume follows the slider while dragging, so it can be heard. */
  protected dragVolume(value: number | null) {
    if (value !== null) this.player.setVolume(value);
  }
}
