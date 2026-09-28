import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { BlockedItem, DiscoverPick, DiscoverResponse, DiscoveryMode, FeedbackRequest, ReleaseSummary } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Session } from '../../core/session';
import { Cover } from '../../shared/catalog/cover';
import { QuickAdd } from '../../shared/catalog/quick-add';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { Icon } from '../../shared/icon/icon';
import { refreshedLabel } from './refreshed-label';

const MODES: { id: DiscoveryMode; label: string }[] = [
  { id: 'safer', label: 'Safer' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'deeper', label: 'Deeper' },
];
/** How long an Undo stays offered. */
const UNDO_MS = 8000;
/** While the server is refreshing, ask again this often. */
const POLL_MS = 3000;

/**
 * Discover (Main and Mobile mockups): Top Picks with quick add, Albums to
 * Start With, and Explore by Tag, for the chosen mode. The mode lives in the
 * URL, so it survives a reload and can be shared.
 */
@Component({
  selector: 'ob-discover-page',
  imports: [RouterLink, Cover, QuickAdd, EmptyState, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './discover-page.scss',
  templateUrl: './discover-page.html',
})
export class DiscoverPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);

  /** Query parameter, via component input binding. */
  readonly mode = input<string | undefined>();

  protected readonly modes = MODES;
  protected readonly current = computed<DiscoveryMode>(() => MODES.find((m) => m.id === this.mode())?.id ?? 'balanced');
  protected readonly data = signal<DiscoverResponse | null>(null);
  protected readonly error = signal('');
  protected readonly addError = signal('');
  protected readonly undo = signal<{ text: string; run: () => Promise<void> } | null>(null);
  private poll: ReturnType<typeof setTimeout> | undefined;
  private undoTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly firstRun = computed(() => !this.data()?.generatedAt && !!this.data()?.refreshing);
  protected readonly refreshed = computed(() => {
    const at = this.data()?.generatedAt;
    return at ? refreshedLabel(at) : '';
  });
  protected readonly picks = computed(() => this.data()?.items.slice(0, 12) ?? []);

  constructor() {
    // Load when the mode changes, and only then: load() reads the current data,
    // which must not make every change to the list trigger a reload.
    effect(() => {
      const mode = this.current();
      untracked(() => void this.load(mode));
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.poll);
      clearTimeout(this.undoTimer);
    });
  }

  protected choose(mode: DiscoveryMode) {
    void this.router.navigate([], { queryParams: { mode: mode === 'balanced' ? null : mode }, replaceUrl: true });
  }

  /** "Because you like NOFX", or for Deeper's second hop, "Lagwagon, like NOFX". */
  protected reason(pick: DiscoverPick): string {
    return pick.reason.via ? `${pick.reason.via}, like ${pick.reason.seed}` : `Because you like ${pick.reason.seed}`;
  }

  /** One view further along a row (three picks or six albums). */
  protected scroll(row: HTMLElement, direction: 1 | -1) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollBy({ left: direction * row.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
  }

  /** Thumbs up, or clears it when already up. */
  protected async like(pick: DiscoverPick) {
    const value = pick.feedback === 'up' ? null : 'up';
    await this.send({ mbid: pick.mbid, name: pick.name, value }, () => this.setFeedback(pick.mbid, value));
  }

  /** Thumbs down: fewer like this, and this one goes away (with Undo). */
  protected async dislike(pick: DiscoverPick) {
    await this.send({ mbid: pick.mbid, name: pick.name, value: 'down' }, () => {
      const restore = this.remove(pick.mbid);
      this.offerUndo(`${pick.name} is hidden, and you will see less like it. Settings, Discovery lists what you hide.`, async () => {
        await this.api.post('discover/feedback', { mbid: pick.mbid, name: pick.name, value: pick.feedback } satisfies FeedbackRequest);
        restore();
      });
    });
  }

  /** Never show this artist: it goes on the blocklist (Settings, Discovery), with Undo. */
  protected async block(pick: DiscoverPick) {
    try {
      const item = await this.api.post<BlockedItem>('blocklist', { kind: 'artist', mbid: pick.mbid, name: pick.name, source: 'discover' });
      const restore = this.remove(pick.mbid);
      this.offerUndo(`${pick.name} is blocked.`, async () => {
        await this.api.delete(`blocklist/${item.id}`);
        restore();
      });
    } catch (error) {
      this.addError.set(error instanceof ApiError ? error.message : 'Could not block this artist');
    }
  }

  protected async runUndo() {
    const pending = this.undo();
    if (!pending) return;
    clearTimeout(this.undoTimer);
    this.undo.set(null);
    try {
      await pending.run();
    } catch (error) {
      this.addError.set(error instanceof ApiError ? error.message : 'Could not undo that');
    }
  }

  private async send(body: FeedbackRequest, then: () => void) {
    this.addError.set('');
    try {
      await this.api.post('discover/feedback', body);
      then();
    } catch (error) {
      this.addError.set(error instanceof ApiError ? error.message : 'Could not save that');
    }
  }

  private setFeedback(mbid: string, value: DiscoverPick['feedback']) {
    this.data.update((d) => (d ? { ...d, items: d.items.map((i) => (i.mbid === mbid ? { ...i, feedback: value } : i)) } : d));
  }

  /** Takes a pick (and its album) off the page; returns how to put them back where they were. */
  private remove(mbid: string): () => void {
    const before = this.data();
    if (!before) return () => undefined;
    const index = before.items.findIndex((i) => i.mbid === mbid);
    const item = before.items[index];
    const albums: [number, ReleaseSummary][] = before.albums.flatMap((a, i) => (a.artistMbid === mbid ? [[i, a]] : []));
    this.data.set({
      ...before,
      items: before.items.filter((i) => i.mbid !== mbid),
      albums: before.albums.filter((a) => a.artistMbid !== mbid),
    });
    return () =>
      this.data.update((d) => {
        if (!d || !item) return d;
        const items = [...d.items];
        items.splice(index, 0, item);
        const restored = [...d.albums];
        for (const [i, album] of albums) restored.splice(i, 0, album);
        return { ...d, items, albums: restored };
      });
  }

  private offerUndo(text: string, run: () => Promise<void>) {
    clearTimeout(this.undoTimer);
    this.undo.set({ text, run });
    this.undoTimer = setTimeout(() => this.undo.set(null), UNDO_MS);
  }

  protected onAdded(pick: DiscoverPick) {
    this.addError.set('');
    this.data.update((d) => (d ? { ...d, items: d.items.map((i) => (i.mbid === pick.mbid ? { ...i, inLibrary: true } : i)) } : d));
  }

  private async load(mode: DiscoveryMode) {
    clearTimeout(this.poll);
    this.error.set('');
    // Keep what is on screen while switching modes, unless it was another mode's.
    if (this.data()?.mode !== mode) this.data.set(null);
    try {
      const response = await this.api.get<DiscoverResponse>(`discover?mode=${mode}`);
      if (mode !== this.current()) return; // switched again meanwhile
      this.data.set(response);
      if (response.refreshing) this.poll = setTimeout(() => void this.load(mode), POLL_MS);
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load recommendations');
    }
  }
}
