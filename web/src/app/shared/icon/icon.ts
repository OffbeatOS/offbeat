import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'discover'
  | 'search'
  | 'library'
  | 'activity'
  | 'flows'
  | 'shows'
  | 'settings'
  | 'more'
  | 'plus'
  | 'alert'
  | 'chevron-right';

/** 24px viewBox stroke icons at 1.8px, drawn in `currentColor` (Lucide style). */
@Component({
  selector: 'ob-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  styles: `
    :host {
      display: inline-flex;
      flex-shrink: 0;
    }
  `,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth()"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @switch (name()) {
        @case ('discover') {
          <circle cx="12" cy="12" r="9" />
          <path d="M15.5 8.5l-2 5-5 2 2-5z" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="7" />
          <path d="M16.5 16.5L21 21" />
        }
        @case ('library') {
          <path d="M5 4v16M10 4v16M14.5 5l4 14" />
        }
        @case ('activity') {
          <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4 19h16" />
        }
        @case ('flows') {
          <path d="M3 12c3-6 6-6 9 0s6 6 9 0" />
        }
        @case ('shows') {
          <path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z" />
        }
        @case ('settings') {
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="17" r="2" />
        }
        @case ('more') {
          <g fill="currentColor" stroke="none">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </g>
        }
        @case ('plus') {
          <path d="M12 5v14M5 12h14" />
        }
        @case ('alert') {
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5v.01" />
        }
        @case ('chevron-right') {
          <path d="M9 6l6 6-6 6" />
        }
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(20);
  readonly strokeWidth = input(1.8);
}
