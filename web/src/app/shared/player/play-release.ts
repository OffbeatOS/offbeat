import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { AlbumDetail, ReleaseSummary } from '@offbeat/shared';
import { Api } from '../../core/api';
import { Player } from '../../core/player';
import { Session } from '../../core/session';
import { Icon } from '../icon/icon';

/**
 * The play button over an album's art, for albums with files on disk. It
 * sits beside the card's link (a button cannot go inside a link), laid over
 * the square art: give the card's wrapper the `has-play` class and position.
 * Shown on hover or focus, always on touch screens, and while that album plays.
 */
@Component({
  selector: 'ob-play-release',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      aspect-ratio: 1;
      pointer-events: none;
    }

    button {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: var(--accent);
      color: var(--on-accent);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      opacity: 0;
      transform: translateY(4px);
      transition:
        opacity 140ms ease,
        transform 140ms ease;

      &:hover {
        transform: scale(1.05);
      }

      &:focus-visible,
      &.on {
        opacity: 1;
        transform: none;
      }
    }

    :host-context(.has-play:hover) button {
      opacity: 1;
      transform: none;
    }

    @media (hover: none) {
      button {
        opacity: 1;
        transform: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button {
        transition: none;
      }
    }
  `,
  template: `
    @if (visible()) {
      <button
        type="button"
        [class.on]="playingThis()"
        [disabled]="loading()"
        [attr.aria-label]="(playingThis() ? 'Pause ' : 'Play ') + release().title"
        (click)="play()"
      >
        <ob-icon [name]="playingThis() ? 'pause' : 'play'" [size]="18" />
      </button>
    }
  `,
})
export class PlayRelease {
  private readonly api = inject(Api);
  private readonly player = inject(Player);
  private readonly can = inject(Session).can;

  readonly release = input.required<Pick<ReleaseSummary, 'mbid' | 'title' | 'status'>>();

  protected readonly loading = signal(false);
  /** Albums with files: complete, or partly there. */
  protected readonly visible = computed(() => {
    const kind = this.release().status.kind;
    return this.can('stream') && (kind === 'in-library' || kind === 'partial');
  });
  protected readonly playingThis = computed(() => this.player.playing() && this.player.isPlayingFrom(this.release().mbid));

  protected async play() {
    const { mbid } = this.release();
    if (this.player.isPlayingFrom(mbid)) return this.player.toggle();
    this.loading.set(true);
    try {
      this.player.playAlbum(await this.api.get<AlbumDetail>(`albums/${mbid}`));
    } catch {
      // The album page explains problems; here the button just does nothing.
    } finally {
      this.loading.set(false);
    }
  }
}
