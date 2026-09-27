import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Lowercase "offbeat" with the accent dot. */
@Component({
  selector: 'ob-wordmark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'img', 'aria-label': 'Offbeat' },
  styles: `
    @use '../mixins';

    :host {
      display: inline-flex;
      align-items: baseline;
      gap: 2px;
      color: var(--text);
    }

    .name {
      @include mixins.text-wordmark;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      transform: translateY(-9px);
    }
  `,
  template: `<span class="name" aria-hidden="true">offbeat</span><span class="dot"></span>`,
})
export class Wordmark {}
