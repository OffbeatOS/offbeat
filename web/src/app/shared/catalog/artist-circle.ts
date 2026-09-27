import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ArtistSummary } from '@offbeat/shared';

/** Round artist link used on Search (Related Artists in the mockup). */
@Component({
  selector: 'ob-artist-circle',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    a {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      text-align: center;
    }

    .art {
      position: relative;
      width: 100%;
      max-width: 132px;
      aspect-ratio: 1;
      border-radius: 50%;
      overflow: hidden;
      background: var(--surface-2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 34px;
      font-weight: 600;
      color: var(--text-4);
    }

    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .name {
      font-size: 14px;
      font-weight: 500;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .note {
      font-size: 12px;
      color: var(--text-3);
      margin-top: -10px;
    }
  `,
  template: `
    <a [routerLink]="['/artist', artist().mbid]">
      <span class="art" aria-hidden="true">
        {{ initial() }}
        @if (artist().imageUrl && !failed()) {
          <img [src]="artist().imageUrl" alt="" loading="lazy" decoding="async" (error)="failed.set(true)" />
        }
      </span>
      <span class="name">{{ artist().name }}</span>
      <span class="note">{{ artist().inLibrary ? 'In Library' : (artist().disambiguation ?? '') }}</span>
    </a>
  `,
})
export class ArtistCircle {
  readonly artist = input.required<ArtistSummary>();
  protected readonly failed = signal(false);
  protected readonly initial = computed(() => this.artist().name.replace(/^the\s+/i, '').charAt(0).toUpperCase());
}
