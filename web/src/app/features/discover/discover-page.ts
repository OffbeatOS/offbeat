import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { DiscoverPick, DiscoverResponse, DiscoveryMode } from '@offbeat/shared';
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
  private poll: ReturnType<typeof setTimeout> | undefined;

  protected readonly firstRun = computed(() => !this.data()?.generatedAt && !!this.data()?.refreshing);
  protected readonly refreshed = computed(() => {
    const at = this.data()?.generatedAt;
    return at ? refreshedLabel(at) : '';
  });
  protected readonly picks = computed(() => this.data()?.items.slice(0, 12) ?? []);

  constructor() {
    effect(() => void this.load(this.current()));
    inject(DestroyRef).onDestroy(() => clearTimeout(this.poll));
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
