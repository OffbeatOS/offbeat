import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, computed, inject, signal } from '@angular/core';
import type { ArtistSummary, BlockSource, BlockedItem, BlocklistResponse, DiscoverResponse, SearchResponse } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../../shared/icon/icon';
import { SettingsSection } from './settings-section';

type Kind = 'artists' | 'tags';

const SOURCE_LABEL: Record<BlockSource, string> = {
  discover: 'Discover',
  search: 'Search',
  settings: 'Settings',
  tag: 'a tag page',
};

/** "today", "yesterday", "3 days ago", "last week", "2 weeks ago", "last month", "4 months ago". */
export function whenLabel(iso: string, now = new Date()): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return 'last month';
  return `${Math.floor(days / 30)} months ago`;
}

/**
 * Settings, Discovery (Settings Discovery mockup). This slice has the
 * blocklist: artists and tags that never appear in recommendations.
 */
@Component({
  selector: 'ob-discovery-settings',
  imports: [SettingsSection, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .block {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-width: 820px;
    }

    .block-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    h3 {
      font-size: 15px;
      font-weight: 600;
    }

    .desc {
      font-size: 13px;
      color: var(--text-3);
      margin-top: 4px;
    }

    .kinds {
      display: flex;
      gap: 6px;

      button {
        height: 30px;
        padding: 0 12px;
        border: 0;
        border-radius: 15px;
        background: var(--surface-2);
        color: var(--text-label);
        font-size: 12px;
        font-weight: 500;

        &[aria-pressed='true'] {
          background: var(--text);
          color: var(--bg);
          font-weight: 600;
        }
      }
    }

    .find {
      position: relative;
    }

    .find input {
      width: 100%;
      height: 40px;
      padding: 0 14px 0 38px;
      border: 1px solid var(--border-input);
      border-radius: var(--radius-input);
      background: var(--surface-input);
      color: var(--text);
      font: inherit;
      font-size: 14px;

      &:focus {
        outline: none;
        border-color: var(--text-3);
      }
    }

    .find ob-icon {
      position: absolute;
      left: 13px;
      top: 12px;
      color: var(--text-3);
    }

    .suggestions {
      position: absolute;
      z-index: 5;
      top: 44px;
      left: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      padding: 6px;
      border: 1px solid var(--border-input);
      border-radius: var(--radius-input);
      background: var(--surface-2);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);

      button {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        padding: 8px 10px;
        border: 0;
        border-radius: var(--radius-nav);
        background: transparent;
        color: var(--text);
        font-size: 14px;
        text-align: left;

        &:hover,
        &:focus-visible {
          background: var(--surface-3);
        }
      }

      .dis {
        font-size: 12px;
        color: var(--text-3);
      }
    }

    .list {
      display: flex;
      flex-direction: column;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 0;
      border-bottom: 1px solid var(--divider);
    }

    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--surface-3);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-4);
    }

    .tag-avatar {
      border-radius: var(--radius-nav);
      font-size: 13px;
    }

    .who {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .name {
      font-size: 14px;
      font-weight: 500;
    }

    .note {
      font-size: 12px;
      color: var(--text-3);
    }

    .unblock {
      height: 32px;
      padding: 0 14px;
      border: 1px solid var(--border-button);
      border-radius: 16px;
      background: transparent;
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 600;

      &:hover:not(:disabled) {
        background: var(--surface-2);
      }
    }

    .empty,
    .error {
      font-size: 13px;
      color: var(--text-3);
      padding: 12px 0;
    }

    .error {
      color: var(--status-failed);
    }
  `,
  template: `
    <ob-settings-section heading="Discovery" description="These settings apply to your account only.">
      <section class="block">
        <div class="block-head">
          <div>
            <h3>Blocklist</h3>
            <p class="desc">Blocked artists and tags never appear in your recommendations.</p>
          </div>
          <div class="kinds" role="group" aria-label="Blocklist type">
            <button type="button" [attr.aria-pressed]="kind() === 'artists'" (click)="switchTo('artists')">
              Artists {{ list()?.artists?.length ?? 0 }}
            </button>
            <button type="button" [attr.aria-pressed]="kind() === 'tags'" (click)="switchTo('tags')">
              Tags {{ list()?.tags?.length ?? 0 }}
            </button>
          </div>
        </div>

        <div class="find">
          <label>
            <span class="visually-hidden">{{ kind() === 'artists' ? 'Block an artist' : 'Block a tag' }}</span>
            <ob-icon name="block" [size]="16" />
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              [placeholder]="kind() === 'artists' ? 'Block an artist' : 'Block a tag, then press Enter'"
              [value]="query()"
              (input)="onType($any($event.target).value)"
              (keydown.enter)="kind() === 'tags' && blockTag()"
              (keydown.escape)="clear()"
              [attr.list]="kind() === 'tags' ? 'known-tags' : null"
            />
          </label>
          <datalist id="known-tags">
            @for (tag of knownTags(); track tag) {
              <option [value]="tag"></option>
            }
          </datalist>
          @if (kind() === 'artists' && matches().length) {
            <div class="suggestions" role="group" aria-label="Artists to block">
              @for (artist of matches(); track artist.mbid) {
                <button type="button" (click)="blockArtist(artist)">
                  {{ artist.name }}
                  @if (artist.disambiguation) {
                    <span class="dis">{{ artist.disambiguation }}</span>
                  }
                </button>
              }
            </div>
          }
        </div>

        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }

        <div class="list">
          @for (item of shown(); track item.id) {
            <div class="row">
              <span class="avatar" [class.tag-avatar]="item.kind === 'tag'" aria-hidden="true">
                {{ item.kind === 'tag' ? '#' : item.name.charAt(0) }}
              </span>
              <span class="who">
                <span class="name">{{ item.name }}</span>
                <span class="note">Blocked from {{ sourceLabel[item.source] }}, {{ when(item.createdAt) }}</span>
              </span>
              <button class="unblock" type="button" [disabled]="busy() === item.id" (click)="unblock(item)">Unblock</button>
            </div>
          } @empty {
            @if (list()) {
              <p class="empty">{{ kind() === 'artists' ? 'No artists blocked.' : 'No tags blocked.' }}</p>
            }
          }
        </div>
      </section>
    </ob-settings-section>
  `,
})
export class DiscoverySettings implements OnInit {
  private readonly api = inject(Api);

  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly when = (iso: string) => whenLabel(iso);
  protected readonly kind = signal<Kind>('artists');
  protected readonly list = signal<BlocklistResponse | null>(null);
  protected readonly query = signal('');
  protected readonly matches = signal<ArtistSummary[]>([]);
  protected readonly knownTags = signal<string[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly shown = computed(() => this.list()?.[this.kind()] ?? []);
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
  }

  async ngOnInit() {
    try {
      this.list.set(await this.api.get<BlocklistResponse>('blocklist'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load your blocklist');
    }
    // Suggestions for tags: the genres on the user's Discover page.
    this.api
      .get<DiscoverResponse>('discover')
      .then((d) => this.knownTags.set(d.tags))
      .catch(() => undefined);
  }

  protected switchTo(kind: Kind) {
    this.kind.set(kind);
    this.clear();
  }

  protected clear() {
    this.query.set('');
    this.matches.set([]);
    this.error.set('');
  }

  protected onType(value: string) {
    this.query.set(value);
    this.error.set('');
    if (this.kind() !== 'artists') return;
    clearTimeout(this.searchTimer);
    const q = value.trim();
    if (q.length < 2) {
      this.matches.set([]);
      return;
    }
    this.searchTimer = setTimeout(() => void this.search(q), 300);
  }

  protected async blockArtist(artist: ArtistSummary) {
    await this.add({ kind: 'artist', mbid: artist.mbid, name: artist.name, source: 'settings' });
  }

  protected async blockTag() {
    const name = this.query().trim();
    if (name) await this.add({ kind: 'tag', name, source: 'settings' });
  }

  protected async unblock(item: BlockedItem) {
    this.busy.set(item.id);
    this.error.set('');
    try {
      await this.api.delete(`blocklist/${item.id}`);
      this.list.update((l) => (l ? { artists: l.artists.filter((a) => a.id !== item.id), tags: l.tags.filter((t) => t.id !== item.id) } : l));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not unblock');
    } finally {
      this.busy.set(null);
    }
  }

  private async add(body: { kind: 'artist'; mbid: string; name: string; source: BlockSource } | { kind: 'tag'; name: string; source: BlockSource }) {
    this.error.set('');
    try {
      const item = await this.api.post<BlockedItem>('blocklist', body);
      this.list.update((l) => {
        const current = l ?? { artists: [], tags: [] };
        const key = item.kind === 'artist' ? 'artists' : 'tags';
        return { ...current, [key]: [item, ...current[key].filter((i) => i.id !== item.id)] };
      });
      this.clear();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not block that');
    }
  }

  private async search(q: string) {
    const seq = ++this.searchSeq;
    try {
      const result = await this.api.get<SearchResponse>(`search?q=${encodeURIComponent(q)}`);
      if (seq !== this.searchSeq) return; // a newer search is on its way
      const top = result.top?.kind === 'artist' ? [result.top.artist] : [];
      this.matches.set([...top, ...result.artists].filter((a) => !a.inLibrary).slice(0, 6));
    } catch {
      if (seq === this.searchSeq) this.matches.set([]);
    }
  }
}
