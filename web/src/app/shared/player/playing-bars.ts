import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The coral equalizer beside the track playing (Playing mockup). It moves
 * while music plays and holds still when paused or with reduced motion.
 */
@Component({
  selector: 'ob-playing-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      height: 14px;
    }

    span {
      width: 3px;
      border-radius: 1px;
      background: var(--accent);
      transform-origin: bottom;
    }

    span:nth-child(1) {
      height: 8px;
    }
    span:nth-child(2) {
      height: 14px;
    }
    span:nth-child(3) {
      height: 5px;
    }
    span:nth-child(4) {
      height: 11px;
    }

    :host(.moving) span {
      animation: bounce 900ms ease-in-out infinite alternate;
    }
    :host(.moving) span:nth-child(2) {
      animation-delay: -300ms;
    }
    :host(.moving) span:nth-child(3) {
      animation-delay: -600ms;
    }
    :host(.moving) span:nth-child(4) {
      animation-delay: -150ms;
    }

    @keyframes bounce {
      from {
        transform: scaleY(0.35);
      }
      to {
        transform: scaleY(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host(.moving) span {
        animation: none;
      }
    }
  `,
  host: { role: 'img', '[attr.aria-label]': "moving() ? 'Playing' : 'Paused'", '[class.moving]': 'moving()' },
  template: `<span></span><span></span><span></span><span></span>`,
})
export class PlayingBars {
  readonly moving = input(true);
}
