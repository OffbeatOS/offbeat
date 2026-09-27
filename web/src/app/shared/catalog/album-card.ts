import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AddResult, ReleaseSummary } from '@offbeat/shared';
import { Cover } from './cover';
import { ReleaseAction } from './release-action';

export function releaseMeta(release: Pick<ReleaseSummary, 'type' | 'year'>): string {
  return release.year ? `${release.type}, ${release.year}` : release.type;
}

/** Album card from the Artist mockup: square art, title, type and year, then status. */
@Component({
  selector: 'ob-album-card',
  imports: [RouterLink, Cover, ReleaseAction],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }

    a {
      display: flex;
      flex-direction: column;
      gap: 10px;

      &:hover ob-cover {
        filter: brightness(1.08);
      }
    }

    .text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .title {
      font-size: 14px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      font-size: 13px;
      color: var(--text-3);
    }
  `,
  template: `
    <a [routerLink]="['/album', release().mbid]">
      <ob-cover [src]="release().coverUrl" />
      <span class="text">
        <span class="title">{{ release().title }}</span>
        <span class="meta">{{ meta() }}</span>
      </span>
    </a>
    <ob-release-action [release]="release()" (added)="added.emit($event)" />
  `,
})
export class AlbumCard {
  readonly release = input.required<ReleaseSummary>();
  readonly added = output<AddResult>();
  protected readonly meta = computed(() => releaseMeta(this.release()));
}
