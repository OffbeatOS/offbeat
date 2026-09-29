import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { PlayedTrack } from '@offbeat/shared';
import { Api } from '../../core/api';
import { Player, playedQueueEntry } from '../../core/player';
import { type ArtTint, artTint } from '../art-tint';
import { Cover } from '../catalog/cover';
import { formatDuration } from '../format';
import { Icon } from '../icon/icon';
import { Progress } from './progress';
import { QueueList } from './queue-list';
import { Range } from './range';
import { Transport } from './transport';

/**
 * Now Playing (NowPlaying and MobileNowPlaying mockups): the art large on a
 * flat tint taken from it, the controls, and Up Next or History beside it
 * (on a phone, Up Next replaces the art). A dialog over the app: Escape or
 * the chevron closes it, and playback never stops for it.
 */
@Component({
  selector: 'ob-now-playing',
  imports: [RouterLink, CdkMenuTrigger, CdkMenu, CdkMenuItem, Cover, Icon, Progress, QueueList, Range, Transport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Now Playing',
    '[style.--tint-bg]': 'tint()?.background ?? null',
    '[style.--tint-text]': 'tint()?.text ?? null',
    '[class.showing-queue]': 'showingQueue()',
    // Escape closes it wherever focus is (a key pressed on the page body never reaches the dialog).
    '(document:keydown.escape)': 'close()',
  },
  styles: `
    @use '../mixins';

    :host {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 440px;
      grid-template-rows: 72px minmax(0, 1fr);
      background: var(--tint-bg, #141816);
      color: var(--text);
      transition: background-color 300ms ease;
      --transport-muted: var(--tint-text, var(--text-3));
      --queue-current: rgba(255, 255, 255, 0.08);
    }

    header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 32px;
    }

    .round {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);

      &:hover {
        background: rgba(255, 255, 255, 0.14);
      }
    }

    .from {
      font-size: 13px;
      color: var(--tint-text, var(--text-3));

      a {
        font-weight: 600;
        color: var(--text);
      }

      .over {
        display: none;
      }
    }

    .stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 32px;
      padding: 0 32px 48px;
      min-height: 0;
    }

    .art {
      width: min(520px, 52vh);
      border-radius: 14px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
    }

    .controls {
      width: min(520px, 52vh);
      min-width: 320px;
      display: flex;
      flex-direction: column;
      gap: 22px;
    }

    .titles {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;

      .title {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.02em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .artist {
        font-size: 18px;
        color: var(--tint-text, var(--text-3));
        align-self: flex-start;

        &:hover {
          color: var(--text);
        }
      }

      .error {
        font-size: 14px;
        color: var(--status-failed);
      }
    }

    .volume {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--tint-text, var(--text-3));

      ob-range {
        flex-grow: 1;
        --range-track: rgba(255, 255, 255, 0.14);
        --range-fill: var(--tint-text, var(--text-3));
      }
    }

    aside {
      border-left: 1px solid rgba(255, 255, 255, 0.06);
      padding: 8px 32px 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 0;
      overflow-y: auto;
    }

    .tabs {
      display: flex;
      gap: 2px;
      padding: 3px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.06);
      align-self: flex-start;

      button {
        height: 32px;
        padding: 0 16px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--tint-text, var(--text-3));
        font-size: 13px;
        font-weight: 500;

        &[aria-pressed='true'] {
          background: rgba(255, 255, 255, 0.14);
          color: var(--text);
          font-weight: 600;
        }
      }
    }

    .history {
      list-style: none;
      margin: 0;
      padding: 0;

      button {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 4px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        text-align: left;

        &:hover {
          background: rgba(255, 255, 255, 0.04);
        }
      }

      ob-cover {
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

      .name {
        font-size: 14px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .by,
      .time {
        font-size: 12px;
        color: var(--text-3);
      }
    }

    .empty {
      font-size: 13px;
      color: var(--text-3);
    }

    .up-next {
      display: none;
    }

    @include mixins.mobile {
      :host {
        display: flex;
        flex-direction: column;
        padding: calc(env(safe-area-inset-top) + 12px) 24px calc(env(safe-area-inset-bottom) + 28px);
        overflow-y: auto;
      }

      header {
        padding: 0;

        .round {
          width: 44px;
          height: 44px;
          background: transparent;
          margin: 0 -10px;
        }
      }

      .from {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;

        .over {
          display: block;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        .lead {
          display: none;
        }

        a {
          font-size: 14px;
        }
      }

      .stage {
        flex-grow: 1;
        align-items: stretch;
        justify-content: flex-start;
        gap: 0;
        padding: 0;
      }

      .art {
        width: 100%;
        margin: 34px 0;
        border-radius: 12px;
      }

      .controls {
        width: 100%;
        min-width: 0;
        gap: 26px;
      }

      .titles .title {
        font-size: 24px;
      }

      .titles .artist {
        font-size: 17px;
      }

      .volume {
        display: none;
      }

      aside {
        display: none;
        border: 0;
        padding: 16px 0 0;
      }

      :host(.showing-queue) {
        .art,
        .controls {
          display: none;
        }

        aside {
          display: flex;
          flex-grow: 1;
          order: 1;
        }

        // The Up Next button stays at the bottom, where it was tapped.
        .stage {
          flex-grow: 0;
          order: 2;
        }

        .tabs {
          display: none;
        }
      }

      .up-next {
        margin-top: auto;
        padding-top: 24px;
        display: flex;
        justify-content: center;

        button {
          height: 40px;
          padding: 0 18px;
          border: 0;
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.08);
          color: var(--text);
          font-size: 13px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;

          &[aria-pressed='true'] {
            background: rgba(255, 255, 255, 0.16);
          }
        }
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        transition: none;
      }
    }
  `,
  template: `
    @if (player.current(); as track) {
      <header>
        <button #closeButton class="round" type="button" aria-label="Close Now Playing" (click)="close()">
          <ob-icon name="chevron-down" [size]="22" [strokeWidth]="2.2" />
        </button>
        @if (player.context(); as from) {
          <span class="from">
            <span class="over">Playing from</span>
            <span><span class="lead">Playing from </span><a [routerLink]="['/album', from.albumMbid]" (click)="close()">{{ from.title }}</a></span>
          </span>
        }
        <button class="round" type="button" aria-label="More" [cdkMenuTriggerFor]="more">
          <ob-icon name="more" [size]="18" />
        </button>
        <ng-template #more>
          <div class="ob-menu" cdkMenu>
            <button class="ob-menu-item" type="button" cdkMenuItem (cdkMenuItemTriggered)="go(['/album', track.albumMbid])">Go to Album</button>
            <button class="ob-menu-item" type="button" cdkMenuItem (cdkMenuItemTriggered)="go(['/artist', track.artistMbid])">Go to Artist</button>
          </div>
        </ng-template>
      </header>

      <div class="stage">
        <ob-cover class="art" [src]="track.coverUrl" radius="14px" />
        <div class="controls">
          <div class="titles">
            <span class="title">{{ track.title }}</span>
            <a class="artist" [routerLink]="['/artist', track.artistMbid]" (click)="close()">{{ track.artistName }}</a>
            @if (player.error(); as error) {
              <span class="error" role="alert">{{ error }}</span>
            }
          </div>
          <ob-progress size="large" />
          <ob-transport size="large" />
          <div class="volume">
            <ob-icon name="volume" [size]="20" />
            <ob-range [value]="player.volume()" [max]="1" [step]="0.01" label="Volume" (changed)="player.setVolume($event)" (dragging)="dragVolume($event)" />
          </div>
        </div>

        <div class="up-next">
          <button type="button" [attr.aria-pressed]="showingQueue()" (click)="showingQueue.set(!showingQueue())">
            <ob-icon name="queue" [size]="18" />Up Next
          </button>
        </div>
      </div>

      <aside aria-label="Up Next">
        <div class="tabs" role="group" aria-label="Panel">
          <button type="button" [attr.aria-pressed]="panel() === 'next'" (click)="panel.set('next')">Up Next</button>
          <button type="button" [attr.aria-pressed]="panel() === 'history'" (click)="panel.set('history')">History</button>
        </div>
        @if (panel() === 'next' || showingQueue()) {
          <ob-queue-list [showCurrent]="false" />
        } @else {
          <ol class="history">
            @for (played of history(); track played.playedAt + played.trackFileId) {
              <li>
                <button type="button" (click)="playAgain(played)" [attr.aria-label]="'Play ' + played.title + ' again'">
                  <ob-cover [src]="played.coverUrl" radius="5px" />
                  <span class="text">
                    <span class="name">{{ played.title }}</span>
                    <span class="by">{{ played.artistName }}</span>
                  </span>
                  @if (played.durationMs) {
                    <span class="time">{{ time(played) }}</span>
                  }
                </button>
              </li>
            } @empty {
              <p class="empty">Tracks you play appear here.</p>
            }
          </ol>
        }
      </aside>
    }
  `,
})
export class NowPlaying {
  protected readonly player = inject(Player);
  private readonly router = inject(Router);

  protected readonly tint = signal<ArtTint | null>(null);
  protected readonly panel = signal<'next' | 'history'>('next');
  /** On a phone, Up Next takes the place of the art. */
  protected readonly showingQueue = signal(false);
  /** What this user played, from any device (saved plays), newest first. */
  protected readonly history = signal<readonly PlayedTrack[]>([]);
  private readonly api = inject(Api);
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  constructor() {
    // The tint follows the art of whatever is playing.
    effect(() => {
      const cover = this.player.current()?.coverUrl ?? null;
      void artTint(cover).then((tint) => {
        if ((this.player.current()?.coverUrl ?? null) === cover) this.tint.set(tint);
      });
    });

    // History loads when shown, and again after each play is recorded.
    effect(() => {
      if (this.panel() !== 'history') return;
      this.player.playsReported();
      void this.api
        .get<PlayedTrack[]>('plays?limit=50')
        .then((plays) => this.history.set(plays))
        .catch(() => undefined);
    });

    // Focus moves into the dialog, and back to where it was when it closes.
    const opener = document.activeElement as HTMLElement | null;
    afterNextRender(() => this.closeButton()?.nativeElement.focus());
    inject(DestroyRef).onDestroy(() => opener?.focus?.());

    // Keep the page underneath still.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inject(DestroyRef).onDestroy(() => (document.body.style.overflow = overflow));
  }

  protected close() {
    this.player.nowPlayingOpen.set(false);
  }

  protected go(commands: string[]) {
    this.close();
    void this.router.navigate(commands);
  }

  protected playAgain(played: PlayedTrack) {
    this.player.playNext([playedQueueEntry(played)]);
    this.player.next();
  }

  protected time(track: PlayedTrack): string {
    return formatDuration((track.durationMs ?? 0) / 1000);
  }

  protected dragVolume(value: number | null) {
    if (value !== null) this.player.setVolume(value);
  }
}
