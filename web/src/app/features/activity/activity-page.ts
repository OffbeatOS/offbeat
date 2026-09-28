import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ActivityItem } from '@offbeat/shared';
import { ApiError } from '../../core/api';
import { ActivityStore } from '../../core/activity-store';
import { STATE_LABEL, percent, stateTone } from '../../shared/catalog/activity-labels';
import { Cover } from '../../shared/catalog/cover';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { timeAgo } from '../../shared/format';
import { Icon } from '../../shared/icon/icon';

type Filter = 'all' | 'progress' | 'failed' | 'completed';

/**
 * Activity mockup: what needs attention, what is moving, and what finished.
 * Live over the shared event stream, so it updates without refreshing.
 */
@Component({
  selector: 'ob-activity-page',
  imports: [RouterLink, Cover, EmptyState, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './activity-page.scss',
  templateUrl: './activity-page.html',
})
export class ActivityPage {
  protected readonly store = inject(ActivityStore);

  protected readonly filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'progress', label: 'In Progress' },
    { id: 'failed', label: 'Failed' },
    { id: 'completed', label: 'Completed' },
  ];
  protected readonly filter = signal<Filter>('all');
  protected readonly busy = signal<string | null>(null);
  protected readonly confirmCancel = signal<string | null>(null);
  protected readonly errors = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly snapshot = this.store.snapshot;
  protected readonly loaded = computed(() => this.snapshot().updatedAt !== null || this.snapshot().error !== null);
  protected readonly show = computed(() => {
    const filter = this.filter();
    return {
      attention: filter === 'all' || filter === 'failed',
      progress: filter === 'all' || filter === 'progress',
      completed: filter === 'all' || filter === 'completed',
    };
  });
  protected readonly empty = computed(() => {
    const { attention, inProgress, completed } = this.snapshot();
    const show = this.show();
    return (
      (!show.attention || attention.length === 0) &&
      (!show.progress || inProgress.length === 0) &&
      (!show.completed || completed.length === 0)
    );
  });

  protected readonly label = STATE_LABEL;
  protected readonly tone = stateTone;
  protected readonly percent = percent;
  protected readonly timeAgo = timeAgo;

  protected sub(item: { artistName: string; source: string }): string {
    return [item.artistName, item.source].filter(Boolean).join(', ');
  }

  /** What the Lidarr link does: its queue (with Manual Import there), or the album for a manual search. */
  protected linkLabel(item: ActivityItem): string {
    if (item.state === 'import-stuck') return 'Manual Import in Lidarr';
    return item.state === 'import-blocked' ? 'Open in Lidarr' : 'Search Manually';
  }

  protected toggleDetails(id: string) {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected async retry(item: ActivityItem) {
    await this.run(item.id, () => this.store.retry(item.id));
  }

  /** First click asks, second click removes the download. */
  protected async cancel(item: ActivityItem) {
    if (this.confirmCancel() !== item.id) {
      this.confirmCancel.set(item.id);
      return;
    }
    this.confirmCancel.set(null);
    await this.run(item.id, () => this.store.cancel(item.id));
  }

  private async run(id: string, action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(id);
    this.errors.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    try {
      await action();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'That did not work';
      this.errors.update((map) => new Map(map).set(id, message));
    } finally {
      this.busy.set(null);
    }
  }
}
