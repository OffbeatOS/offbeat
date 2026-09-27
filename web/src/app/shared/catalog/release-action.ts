import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { AddAlbumRequest, AlbumDetail, ReleaseStatus, ReleaseSummary } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../icon/icon';

/**
 * The status chip for a release, or its Add button (PLAN.md status chip rules):
 * In Library, "N missing" (partial), Wanted (monitored, no files yet), Add.
 * Adding locks the button, so repeated clicks send one request.
 */
@Component({
  selector: 'ob-release-action',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
      flex-direction: column;
      gap: 4px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    }

    .in-library {
      color: var(--text-2);
    }

    .partial {
      color: var(--text-3);
    }

    .requested,
    .adding {
      color: var(--status-progress);
    }

    .add {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 12px;
      border: 1px solid var(--border-button);
      border-radius: 14px;
      background: transparent;
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;

      &:hover:not(:disabled) {
        background: var(--surface-2);
      }
    }

    :host(.large) .add {
      height: 40px;
      padding: 0 18px;
      border-radius: 20px;
      font-size: 14px;
      border: 0;
      background: var(--text);
      color: var(--bg);

      &:hover:not(:disabled) {
        background: #fff;
      }
    }

    :host(.large) .chip {
      font-size: 14px;
    }

    .error {
      max-width: 220px;
      font-size: 12px;
      line-height: 1.35;
      color: var(--status-failed);
    }
  `,
  template: `
    @switch (status().kind) {
      @case ('in-library') {
        <span class="chip in-library"><ob-icon name="check" [size]="13" [strokeWidth]="2.6" />In Library</span>
      }
      @case ('partial') {
        <span class="chip partial">{{ missingLabel() }}</span>
      }
      @case ('requested') {
        <span class="chip requested">Wanted</span>
      }
      @default {
        @if (adding()) {
          <span class="chip adding" role="status">Adding</span>
        } @else {
          <button class="add" type="button" [attr.aria-label]="'Add ' + release().title" (click)="add($event)">
            <ob-icon name="plus" [size]="13" [strokeWidth]="2.4" />Add
          </button>
        }
      }
    }
    @if (error()) {
      <span class="error" role="alert">{{ error() }}</span>
    }
  `,
})
export class ReleaseAction {
  private readonly api = inject(Api);

  readonly release = input.required<ReleaseSummary>();
  readonly added = output<AlbumDetail>();

  private readonly override = signal<ReleaseStatus | null>(null);
  protected readonly adding = signal(false);
  protected readonly error = signal('');

  protected readonly status = computed(() => this.override() ?? this.release().status);
  protected readonly missingLabel = computed(() => {
    const status = this.status();
    return status.kind === 'partial' ? `${status.missingTracks} missing` : '';
  });

  protected async add(event: Event) {
    // Cards are links; the button must not navigate.
    event.preventDefault();
    event.stopPropagation();
    if (this.adding()) return;
    this.adding.set(true);
    this.error.set('');
    try {
      const request: AddAlbumRequest = { artistMbid: this.release().artistMbid };
      const detail = await this.api.post<AlbumDetail>(`albums/${this.release().mbid}`, request);
      this.override.set(detail.status);
      this.added.emit(detail);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not add this album');
    } finally {
      this.adding.set(false);
    }
  }
}
