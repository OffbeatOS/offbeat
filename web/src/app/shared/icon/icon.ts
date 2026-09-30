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
  | 'chevron-up'
  | 'chevron-down'
  | 'grip'
  | 'check'
  | 'close'
  | 'thumbs-up'
  | 'thumbs-down'
  | 'block'
  | 'play'
  | 'pause'
  | 'previous'
  | 'next'
  | 'shuffle'
  | 'repeat'
  | 'repeat-one'
  | 'queue'
  | 'volume'
  | 'volume-off'
  | 'expand';

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
        @case ('chevron-up') {
          <path d="M6 15l6-6 6 6" />
        }
        @case ('chevron-down') {
          <path d="M6 9l6 6 6-6" />
        }
        @case ('grip') {
          <g fill="currentColor" stroke="none">
            <circle cx="9" cy="6" r="1.6" />
            <circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" />
            <circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" />
            <circle cx="15" cy="18" r="1.6" />
          </g>
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
        <!-- Player controls (Playing mockup). The filled ones ignore strokeWidth. -->
        @case ('play') {
          <path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
        }
        @case ('pause') {
          <g fill="currentColor" stroke="none">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </g>
        }
        @case ('previous') {
          <g fill="currentColor" stroke="none">
            <rect x="5" y="6" width="2.2" height="12" rx="1" />
            <path d="M19 6.5v11l-9-5.5z" />
          </g>
        }
        @case ('next') {
          <g fill="currentColor" stroke="none">
            <rect x="16.8" y="6" width="2.2" height="12" rx="1" />
            <path d="M5 6.5v11l9-5.5z" />
          </g>
        }
        @case ('shuffle') {
          <path d="M4 7h3c4 0 6 10 10 10h3M17 14l3 3-3 3M4 17h3c1.5 0 2.7-1.4 3.7-3M13.3 10c1-1.6 2.2-3 3.7-3h3M17 4l3 3-3 3" />
        }
        @case ('repeat') {
          <path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3" />
        }
        @case ('repeat-one') {
          <path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3M11.5 10.5l1-1v5" />
        }
        @case ('queue') {
          <path d="M4 6h11M4 11h11M4 16h6" />
          <circle cx="16" cy="17" r="2.5" />
          <path d="M18.5 17V9.5l2.5-1" />
        }
        @case ('volume') {
          <path d="M4 9.5v5h3.5l4.5 3.8V5.7L7.5 9.5z" />
          <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
        }
        @case ('volume-off') {
          <path d="M4 9.5v5h3.5l4.5 3.8V5.7L7.5 9.5z" />
          <path d="M16 9.5l5 5M21 9.5l-5 5" />
        }
        @case ('expand') {
          <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />
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
