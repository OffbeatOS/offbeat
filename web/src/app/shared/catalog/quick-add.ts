import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import type { ArtistDetail } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../icon/icon';
import { Session } from '../../core/session';

/**
 * The round coral add button on artist artwork (Discover and Tag mockups).
 * Adds the artist with the saved defaults; shows a check once it is in the
 * library. Sits inside links, so it never lets a click navigate.
 */
@Component({
  selector: 'ob-quick-add',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.done]': 'added()', '[class.busy]': 'busy()' },
  styles: `
    :host {
      display: inline-flex;
    }

    button {
      width: var(--quick-add-size, 40px);
      height: var(--quick-add-size, 40px);
      border: 0;
      border-radius: 50%;
      background: var(--accent);
      color: var(--on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      transition:
        transform 120ms ease,
        background 120ms ease;

      &:hover:not(:disabled) {
        transform: scale(1.06);
      }

      &:disabled {
        cursor: default;
      }
    }

    :host(.done) button {
      background: var(--surface-3);
      color: var(--text);
    }

    :host(.busy) button {
      opacity: 0.75;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid currentColor;
      border-right-color: transparent;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
  `,
  template: `
    @if (added() || can('add-artists')) {
      <button
        type="button"
        [disabled]="busy() || added()"
        [attr.aria-label]="added() ? name() + ' is in your library' : 'Add ' + name() + ' to your library'"
        [title]="error() || (added() ? 'In your library' : 'Add to library')"
        (click)="add($event)"
      >
        @if (busy()) {
          <span class="spinner" aria-hidden="true"></span>
        } @else if (added()) {
          <ob-icon name="check" [size]="18" [strokeWidth]="2.6" />
        } @else {
          <ob-icon name="plus" [size]="18" [strokeWidth]="2.4" />
        }
      </button>
    }
  `,
})
export class QuickAdd {
  private readonly api = inject(Api);
  /** Hides what the server would refuse this user (see Session.can). */
  protected readonly can = inject(Session).can;

  readonly mbid = input.required<string>();
  readonly name = input.required<string>();
  readonly inLibrary = input(false);
  readonly done = output<ArtistDetail>();
  readonly failed = output<string>();

  protected readonly busy = signal(false);
  protected readonly addedNow = signal(false);
  protected readonly error = signal('');
  protected added = () => this.inLibrary() || this.addedNow();

  protected async add(event: Event) {
    // Artwork is a link to the artist; the button must not navigate.
    event.preventDefault();
    event.stopPropagation();
    if (this.busy() || this.added()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const artist = await this.api.post<ArtistDetail>(`artists/${this.mbid()}`);
      this.addedNow.set(true);
      this.done.emit(artist);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Could not add this artist';
      this.error.set(message);
      this.failed.emit(message);
    } finally {
      this.busy.set(false);
    }
  }
}
