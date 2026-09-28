import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { DiscoverPreferences, DiscoverSectionId, DiscoverStatus, DiscoveryMode } from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Icon } from '../../shared/icon/icon';

const MODES: { id: DiscoveryMode; label: string }[] = [
  { id: 'safer', label: 'Safer' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'deeper', label: 'Deeper' },
];

const SECTIONS: Record<DiscoverSectionId, { name: string; note: string }> = {
  picks: { name: 'Top Picks for You', note: 'Artists picked from your library and listening' },
  albums: { name: 'Albums to Start With', note: 'A good first album from each recommended artist' },
  tags: { name: 'Explore by Tag', note: 'Genres across your recommendations' },
};

/** While a refresh runs, ask how it is going this often. */
const POLL_MS = 2000;

const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "today at 4:02 AM", "yesterday at 4:02 AM", or "on Sep 25 at 4:02 AM". */
export function lastRefreshedLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `today at ${time(at)}`;
  if (days === 1) return `yesterday at ${time(at)}`;
  return `on ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time(at)}`;
}

/**
 * Settings, Discovery (Settings Discovery mockup): Recommendations (Refresh
 * Now with progress, and the default mode) and Discover sections (reorder by
 * dragging or with Move up and Move down, and hide).
 */
@Component({
  selector: 'ob-discovery-preferences',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 40px;
      max-width: 820px;
    }

    section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    h3 {
      font-size: 15px;
      font-weight: 600;
    }

    .desc,
    .sub {
      font-size: 13px;
      color: var(--text-3);
    }

    .desc {
      margin-top: 4px;
    }

    .setting {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      padding: 18px 0;
      border-bottom: 1px solid var(--divider);

      &:first-of-type {
        border-top: 1px solid var(--divider);
      }
    }

    .what {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }

    .label {
      font-size: 14px;
      font-weight: 500;
    }

    .sub.failed {
      color: var(--status-failed);
    }

    .refresh {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .schedule {
      font-size: 13px;
      color: var(--text-label);
    }

    .refresh-now {
      height: 36px;
      padding: 0 16px;
      border: 0;
      border-radius: 18px;
      background: var(--surface-3);
      color: var(--text-soft);
      font-size: 13px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 8px;

      &:disabled {
        opacity: 0.7;
        cursor: default;
      }
    }

    .spinner {
      width: 13px;
      height: 13px;
      border-radius: 50%;
      border: 2px solid currentColor;
      border-right-color: transparent;
      animation: spin 0.8s linear infinite;
    }

    .bar {
      flex-basis: 100%;
      height: 4px;
      border-radius: 2px;
      background: var(--surface-3);
      overflow: hidden;

      span {
        display: block;
        height: 100%;
        background: var(--accent);
        transition: width 300ms ease;
      }
    }

    .modes {
      display: flex;
      gap: 2px;
      padding: 3px;
      background: var(--surface-2);
      border-radius: 10px;

      button {
        height: 32px;
        padding: 0 14px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--text-label);
        font-size: 13px;
        font-weight: 500;

        &[aria-pressed='true'] {
          background: var(--surface-3);
          color: var(--text);
          font-weight: 600;
        }
      }
    }

    .sections {
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--divider);
    }

    .section-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 0;
      border-bottom: 1px solid var(--divider);
      background: var(--bg);

      &.dragging {
        opacity: 0.5;
      }
    }

    .grip {
      color: var(--text-4);
      display: flex;
      cursor: grab;
    }

    .section-row .what {
      flex-grow: 1;
    }

    .section-row.off .label {
      color: var(--text-3);
    }

    .note {
      font-size: 12px;
      color: var(--text-3);
    }

    .move {
      display: flex;
      gap: 4px;

      button {
        width: 32px;
        height: 32px;
        border: 1px solid var(--border-button);
        border-radius: 50%;
        background: transparent;
        color: var(--text-soft);
        display: flex;
        align-items: center;
        justify-content: center;

        &:disabled {
          opacity: 0.35;
          cursor: default;
        }

        &:hover:not(:disabled) {
          background: var(--surface-2);
        }
      }
    }

    [role='switch'] {
      width: 44px;
      height: 26px;
      flex-shrink: 0;
      padding: 0;
      border: 0;
      border-radius: 13px;
      background: var(--surface-4);
      position: relative;

      &::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #fff;
        transition: left 120ms ease;
      }

      &[aria-checked='true'] {
        background: var(--accent);

        &::after {
          left: 21px;
        }
      }
    }

    .error {
      font-size: 13px;
      color: var(--status-failed);
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

      .bar span,
      [role='switch']::after {
        transition: none;
      }
    }
  `,
  template: `
    <section aria-labelledby="recs-heading">
      <h3 id="recs-heading">Recommendations</h3>
      <div>
        <div class="setting">
          <div class="what">
            <span class="label">Refresh</span>
            @if (status(); as s) {
              @if (s.refreshing) {
                <span class="sub" role="status">
                  @if (s.progress; as p) {
                    Step {{ p.step }} of {{ p.steps }}: {{ p.label }}
                  } @else {
                    Starting
                  }
                </span>
              } @else if (s.error) {
                <span class="sub failed" role="alert">The last refresh failed: {{ s.error }}</span>
              } @else if (s.generatedAt) {
                <span class="sub">Last refreshed {{ lastRefreshed(s.generatedAt) }}</span>
              } @else {
                <span class="sub">Not refreshed yet</span>
              }
            }
          </div>
          <div class="refresh">
            @if (schedule()) {
              <span class="schedule">{{ schedule() }}</span>
            }
            <button class="refresh-now" type="button" [disabled]="!status() || status()!.refreshing" (click)="refreshNow()">
              @if (status()?.refreshing) {
                <span class="spinner" aria-hidden="true"></span>
                Refreshing
              } @else {
                Refresh Now
              }
            </button>
          </div>
          @if (status()?.refreshing) {
            <div class="bar" aria-hidden="true"><span [style.width.%]="progressPercent()"></span></div>
          }
        </div>
        <div class="setting">
          <div class="what">
            <span class="label" id="default-mode-label">Default mode</span>
            <span class="sub">What Discover opens with. You can still switch on the page.</span>
          </div>
          <div class="modes" role="group" aria-labelledby="default-mode-label">
            @for (m of modes; track m.id) {
              <button type="button" [attr.aria-pressed]="prefs()?.defaultMode === m.id" [disabled]="!prefs()" (click)="setMode(m.id)">
                {{ m.label }}
              </button>
            }
          </div>
        </div>
      </div>
    </section>

    <section aria-labelledby="sections-heading">
      <div>
        <h3 id="sections-heading">Discover sections</h3>
        <p class="desc">Drag to reorder, or use the arrows. Hidden sections stay off your Discover page.</p>
      </div>
      <div class="sections" (dragover)="$event.preventDefault()" (drop)="$event.preventDefault()">
        @for (section of prefs()?.sections ?? []; track section.id; let i = $index, last = $last) {
          <div
            class="section-row"
            [class.off]="!section.visible"
            [class.dragging]="dragging() === section.id"
            [attr.data-section]="section.id"
            draggable="true"
            (dragstart)="dragStart($event, section.id)"
            (dragenter)="dragOver(section.id)"
            (dragend)="dragEnd()"
          >
            <span class="grip" aria-hidden="true" title="Drag to reorder"><ob-icon name="grip" [size]="18" /></span>
            <span class="what">
              <span class="label">{{ info[section.id].name }}</span>
              <span class="note">{{ info[section.id].note }}</span>
            </span>
            <span class="move">
              <button
                type="button"
                class="up"
                [attr.aria-label]="'Move ' + info[section.id].name + ' up'"
                [disabled]="i === 0"
                (click)="move(section.id, -1)"
              >
                <ob-icon name="chevron-up" [size]="16" />
              </button>
              <button
                type="button"
                class="down"
                [attr.aria-label]="'Move ' + info[section.id].name + ' down'"
                [disabled]="last"
                (click)="move(section.id, 1)"
              >
                <ob-icon name="chevron-down" [size]="16" />
              </button>
            </span>
            <button
              type="button"
              role="switch"
              [attr.aria-checked]="section.visible"
              [attr.aria-label]="'Show ' + info[section.id].name"
              (click)="toggle(section.id)"
            ></button>
          </div>
        }
      </div>
      <p class="visually-hidden" role="status">{{ announcement() }}</p>
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
})
export class DiscoveryPreferences implements OnInit {
  private readonly api = inject(Api);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly modes = MODES;
  protected readonly info = SECTIONS;
  protected readonly lastRefreshed = (iso: string) => lastRefreshedLabel(iso);
  protected readonly status = signal<DiscoverStatus | null>(null);
  protected readonly prefs = signal<DiscoverPreferences | null>(null);
  protected readonly error = signal('');
  protected readonly announcement = signal('');
  protected readonly dragging = signal<DiscoverSectionId | null>(null);
  protected readonly schedule = computed(() => {
    const next = this.status()?.nextRefreshAt;
    return next ? `Daily at ${time(new Date(next))}` : '';
  });
  /** A running refresh's progress: at least a sliver, so it reads as started. */
  protected readonly progressPercent = computed(() => {
    const p = this.status()?.progress;
    return p ? Math.max(8, ((p.step - 1) / p.steps) * 100 + 100 / p.steps / 2) : 8;
  });
  private poll: ReturnType<typeof setTimeout> | undefined;
  /** The order before a drag began, to tell whether it changed anything. */
  private dragStartOrder = '';

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.poll));
  }

  async ngOnInit() {
    void this.loadStatus();
    try {
      this.prefs.set(await this.api.get<DiscoverPreferences>('discover/preferences'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load your Discover settings');
    }
  }

  protected async refreshNow() {
    this.error.set('');
    // Disable at once: a first refresh can take over a minute.
    this.status.update((s) => (s ? { ...s, refreshing: true, progress: null, error: null } : s));
    try {
      await this.api.post('discover/refresh');
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not start a refresh');
    }
    await this.loadStatus();
  }

  protected setMode(mode: DiscoveryMode) {
    const prefs = this.prefs();
    if (prefs && prefs.defaultMode !== mode) void this.save({ ...prefs, defaultMode: mode });
  }

  protected toggle(id: DiscoverSectionId) {
    const prefs = this.prefs();
    if (!prefs) return;
    const sections = prefs.sections.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s));
    void this.save({ ...prefs, sections });
  }

  /** Move up (-1) or down (1), for keyboard and touch; keeps focus on the moved row. */
  protected move(id: DiscoverSectionId, by: -1 | 1) {
    const prefs = this.prefs();
    if (!prefs) return;
    const from = prefs.sections.findIndex((s) => s.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= prefs.sections.length) return;
    const sections = reorder(prefs.sections, from, to);
    this.announcement.set(`${SECTIONS[id].name} moved to position ${to + 1} of ${sections.length}.`);
    void this.save({ ...prefs, sections });
    // Moving the row can take focus with it; put it back on the same arrow, or
    // on the other one when this one is now disabled at the top or bottom.
    afterNextRender(
      () => {
        const row = this.host.nativeElement.querySelector(`[data-section="${id}"]`);
        const same = row?.querySelector<HTMLButtonElement>(by < 0 ? '.up' : '.down');
        const other = row?.querySelector<HTMLButtonElement>(by < 0 ? '.down' : '.up');
        (same && !same.disabled ? same : other)?.focus();
      },
      { injector: this.injector },
    );
  }

  protected dragStart(event: DragEvent, id: DiscoverSectionId) {
    this.dragging.set(id);
    this.dragStartOrder = this.order();
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  /** Dragging over another row moves the dragged one there, so the list shows where it will land. */
  protected dragOver(overId: DiscoverSectionId) {
    const prefs = this.prefs();
    const id = this.dragging();
    if (!prefs || !id || id === overId) return;
    const from = prefs.sections.findIndex((s) => s.id === id);
    const to = prefs.sections.findIndex((s) => s.id === overId);
    this.prefs.set({ ...prefs, sections: reorder(prefs.sections, from, to) });
  }

  protected dragEnd() {
    const id = this.dragging();
    this.dragging.set(null);
    const prefs = this.prefs();
    if (!prefs || !id || this.order() === this.dragStartOrder) return;
    const at = prefs.sections.findIndex((s) => s.id === id);
    this.announcement.set(`${SECTIONS[id].name} moved to position ${at + 1} of ${prefs.sections.length}.`);
    void this.save(prefs);
  }

  private order() {
    return (this.prefs()?.sections ?? []).map((s) => s.id).join(',');
  }

  /** Shows the change at once and saves it; puts things back if the save fails. */
  private async save(next: DiscoverPreferences) {
    const before = this.prefs();
    this.prefs.set(next);
    this.error.set('');
    try {
      this.prefs.set(await this.api.put<DiscoverPreferences>('discover/preferences', next));
    } catch (error) {
      this.prefs.set(before);
      this.error.set(error instanceof ApiError ? error.message : 'Could not save that');
    }
  }

  private async loadStatus() {
    clearTimeout(this.poll);
    try {
      const status = await this.api.get<DiscoverStatus>('discover/status');
      this.status.set(status);
      if (status.refreshing) this.poll = setTimeout(() => void this.loadStatus(), POLL_MS);
    } catch {
      // Keep what is shown; the button stays usable.
      this.status.update((s) => s ?? { refreshing: false, progress: null, generatedAt: null, error: null, nextRefreshAt: null });
    }
  }
}

function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
