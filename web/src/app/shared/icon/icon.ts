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
  | 'chevron-right'
  | 'chevron-left'
  | 'check'
  | 'close'
  | 'thumbs-up'
  | 'thumbs-down'
  | 'block';

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
        @case ('chevron-left') {
          <path d="M15 6l-6 6 6 6" />
        }
        @case ('close') {
          <path d="M6 6l12 12M18 6L6 18" />
        }
        @case ('check') {
          <path d="M5 12.5l4.5 4.5L19 7" />
        }
        @case ('chevron-right') {
          <path d="M9 6l6 6-6 6" />
        }
        @case ('thumbs-up') {
          <path d="M7 10v11H4V10z" />
          <path d="M7 10l4-7c1.7 0 2.7 1.2 2.4 2.9L13 9h5.3a2 2 0 0 1 2 2.4l-1.4 7.2A2 2 0 0 1 16.9 21H7" />
        }
        @case ('thumbs-down') {
          <path d="M17 14V3h3v11z" />
          <path d="M17 14l-4 7c-1.7 0-2.7-1.2-2.4-2.9L11 15H5.7a2 2 0 0 1-2-2.4l1.4-7.2A2 2 0 0 1 7.1 3H17" />
        }
        @case ('block') {
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6l12.8 12.8" />
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
