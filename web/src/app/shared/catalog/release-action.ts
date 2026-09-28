import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, output, signal } from '@angular/core';
import type { AddAlbumRequest, AddResult, AlbumDetail, ReleaseStatus, ReleaseSummary } from '@offbeat/shared';
import { ActivityStore } from '../../core/activity-store';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../icon/icon';
import { STATE_LABEL, percent, stateTone } from './activity-labels';
import { Session } from '../../core/session';

/**
 * The status chip for a release, or its Add button (status chip rules in
 * docs/design): In Library, "N missing", Wanted (plain text), live Searching
 * and the like (with a pulsing dot, so they read as work under way), Downloading
 * (with a bar), Import blocked, Failed, or Add. Adding answers at once with
 * "Adding"; the background add reports back over the activity stream. When
 * adding would resume other albums the user left monitored in Lidarr, it asks
 * first.
 */
@Component({
  selector: 'ob-release-action',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './release-action.scss',
  template: `
    @if (live(); as item) {
      <span [class]="'chip ' + tone(item.state)">
        @if (tone(item.state) === 'failed') {
          <ob-icon name="alert" [size]="13" [strokeWidth]="2" />
        } @else if (item.state !== 'downloading' && item.state !== 'paused') {
          <span class="pulse" aria-hidden="true"></span>
        }
        {{ label[item.state] }}{{ item.state === 'downloading' && item.progress !== null ? ' ' + percent(item.progress) : '' }}
      </span>
      @if (item.state === 'downloading') {
        <span class="track"><span class="fill" [style.width.%]="(item.progress ?? 0) * 100"></span></span>
      }
    } @else {
      @switch (status().kind) {
        @case ('in-library') {
          <span class="chip in-library"><ob-icon name="check" [size]="13" [strokeWidth]="2.6" />In Library</span>
        }
        @case ('partial') {
          <span class="chip partial">{{ missingLabel() }}</span>
        }
        @case ('requested') {
          <span class="chip progress">Wanted</span>
        }
        @case ('adding') {
          <span class="chip progress" role="status"><span class="pulse" aria-hidden="true"></span>Adding</span>
        }
        @default {
          @if (can('add-albums')) {
            <button class="add" type="button" [attr.aria-label]="'Add ' + release().title" (click)="add($event)">
              <ob-icon name="plus" [size]="13" [strokeWidth]="2.4" />Add
            </button>
          }
        }
      }
    }
    @if (confirm(); as message) {
      <span class="confirm" role="alert">
        {{ message }}
        <span class="confirm-actions">
          <button type="button" (click)="add($event, true)">Add anyway</button>
          <button type="button" (click)="cancel($event)">Cancel</button>
        </span>
      </span>
    }
    @if (error()) {
      <span class="error" role="alert">{{ error() }}</span>
    }
  `,
})
export class ReleaseAction {
  private readonly api = inject(Api);
  /** Hides what the server would refuse this user (see Session.can). */
  protected readonly can = inject(Session).can;
  private readonly store = inject(ActivityStore);

  readonly release = input.required<ReleaseSummary>();
  /** Emitted when a background add finishes successfully. */
  readonly added = output<AddResult>();

  /** Local status until the page hands over fresh data for this release (then it resets). */
  private readonly override = linkedSignal<ReleaseSummary, ReleaseStatus | null>({
    source: this.release,
    computation: () => null,
  });
  /** Whether the activity stream had this release last time, to notice when it leaves. */
  private wasActive = false;
  /** The add result that existed before this component's own add, so stale ones are ignored. */
  private baseline: AddResult | undefined;
  private waiting = false;
  protected readonly error = signal('');
  /** Why the add needs a second click (409 from the server), or empty. */
  protected readonly confirm = signal('');

  protected readonly label = STATE_LABEL;
  protected readonly tone = stateTone;
  protected readonly percent = percent;

  protected readonly status = computed(() => this.override() ?? this.release().status);
  protected readonly missingLabel = computed(() => {
    const status = this.status();
    return status.kind === 'partial' ? `${status.missingTracks} missing` : '';
  });

  /** Searching, downloading, and the like, straight from the activity stream. */
  protected readonly live = computed(() => {
    const item = this.store.byAlbum().get(this.release().mbid);
    if (!item || item.state === 'adding') return null;
    // Once everything is on disk, the library status is the whole story.
    return this.status().kind === 'in-library' ? null : item;
  });

  constructor() {
    // Imported, removed, or retried: the status from page load is stale now, so ask again.
    effect(() => {
      const item = this.store.byAlbum().get(this.release().mbid);
      const active = !!item && item.state !== 'adding';
      if (this.wasActive && !active) void this.refreshStatus();
      this.wasActive = active;
    });
    effect(() => {
      const result = this.store.addResults().get(this.release().mbid);
      if (!this.waiting || !result || result === this.baseline) return;
      this.waiting = false;
      if (result.ok) {
        this.override.set(result.status ?? { kind: 'requested' });
        this.added.emit(result);
      } else {
        this.override.set({ kind: 'available' });
        this.error.set(result.error ?? 'Could not add this album');
      }
    });
  }

  private async refreshStatus() {
    try {
      const album = await this.api.get<AlbumDetail>(`albums/${this.release().mbid}`);
      this.override.set(album.status);
    } catch {
      // keep what is shown; the next page load corrects it
    }
  }

  protected cancel(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    this.confirm.set('');
  }

  protected async add(event: Event, resumeMonitoring = false) {
    // Cards are links; the button must not navigate.
    event.preventDefault();
    event.stopPropagation();
    if (this.status().kind === 'adding') return;
    this.error.set('');
    this.confirm.set('');
    this.baseline = this.store.addResults().get(this.release().mbid);
    this.waiting = true;
    this.override.set({ kind: 'adding' });
    try {
      const request: AddAlbumRequest = { artistMbid: this.release().artistMbid, resumeMonitoring };
      await this.api.post<{ status: ReleaseStatus }>(`albums/${this.release().mbid}`, request);
    } catch (error) {
      this.waiting = false;
      this.override.set(null);
      if (error instanceof ApiError && error.status === 409) this.confirm.set(error.message);
      else this.error.set(error instanceof ApiError ? error.message : 'Could not add this album');
    }
  }
}
