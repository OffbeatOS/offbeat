import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { ArtistPreview } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Player } from '../../core/player';
import { Session } from '../../core/session';
import { Icon } from '../icon/icon';

/**
 * Plays 30-second previews (from Deezer) of an artist not in the library:
 * a round button over a card's image, or a "Preview" pill on the artist
 * page. Only for users who may stream; the round button hides when Deezer
 * has no confirmed match, and the pill says so.
 */
@Component({
  selector: 'ob-preview-button',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.pill]': "look() === 'pill'", '[hidden]': '!shown()' },
  styles: `
    :host {
      display: inline-flex;
    }

    :host([hidden]) {
      display: none;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 0;
      color: #fff;
    }

    :host(:not(.pill)) button {
      width: var(--preview-size, 40px);
      height: var(--preview-size, 40px);
      padding: 0;
      border-radius: 50%;
      background: rgba(17, 17, 19, 0.72);
      backdrop-filter: blur(6px);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);

      &:hover {
        background: rgba(17, 17, 19, 0.9);
      }

      &.on {
        background: var(--accent);
        color: var(--on-accent);
      }
    }

    :host(.pill) button {
      height: 44px;
      padding: 0 20px;
      border-radius: 22px;
      background: var(--surface-3);
      color: var(--text);
      font-size: 14px;
      font-weight: 600;

      &.on {
        color: var(--accent);
      }

      &:disabled {
        opacity: 0.6;
        cursor: default;
      }
    }
  `,
  template: `
    <button
      type="button"
      [class.on]="playingThis()"
      [disabled]="loading() || none()"
      [attr.aria-label]="label()"
      [title]="none() ? 'Deezer has no preview for this artist' : ''"
      (click)="play()"
    >
      <ob-icon [name]="playingThis() ? 'pause' : 'play'" [size]="16" />
      @if (look() === 'pill') {
        {{ none() ? 'No preview' : loading() ? 'Finding preview' : playingThis() ? 'Pause preview' : 'Preview' }}
      }
    </button>
  `,
})
export class PreviewButton {
  private readonly api = inject(Api);
  private readonly player = inject(Player);
  private readonly can = inject(Session).can;

  readonly mbid = input.required<string>();
  readonly name = input.required<string>();
  readonly inLibrary = input(false);
  readonly look = input<'round' | 'pill'>('round');

  protected readonly loading = signal(false);
  /** Deezer has no confirmed match for this artist. */
  protected readonly none = signal(false);
  protected readonly shown = computed(
    () => this.can('stream') && !this.inLibrary() && (this.look() === 'pill' || !this.none()),
  );
  protected readonly playingThis = computed(() => this.player.playing() && this.player.isPreviewing(this.mbid()));
  protected readonly label = computed(() => `${this.playingThis() ? 'Pause preview of' : 'Preview'} ${this.name()}`);

  protected async play() {
    if (this.player.isPreviewing(this.mbid())) return this.player.toggle();
    this.loading.set(true);
    try {
      const path = `artists/${this.mbid()}/preview?name=${encodeURIComponent(this.name())}`;
      this.player.playPreview(await this.api.get<ArtistPreview>(path));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.none.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
