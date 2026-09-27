import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

/**
 * Square album art (album mockups): the image when there is one, otherwise a
 * quiet placeholder with the ring from the mockup. Loads lazily.
 */
@Component({
  selector: 'ob-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.border-radius]': 'radius()' },
  styles: `
    :host {
      position: relative;
      display: block;
      aspect-ratio: 1;
      overflow: hidden;
      background: var(--surface-2);
    }

    .ring {
      position: absolute;
      width: 70%;
      height: 70%;
      left: 15%;
      top: 15%;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 160ms ease;

      &.loaded {
        opacity: 1;
      }
    }
  `,
  template: `
    <span class="ring" aria-hidden="true"></span>
    @if (src() && !failed()) {
      <img
        [src]="src()"
        alt=""
        loading="lazy"
        decoding="async"
        [class.loaded]="loaded()"
        (load)="loaded.set(true)"
        (error)="failed.set(true)"
      />
    }
  `,
})
export class Cover {
  readonly src = input<string | null>(null);
  readonly radius = input('8px');
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
}
