import type { IconName } from '../shared/icon/icon';

export interface NavItem {
  label: string;
  path: string;
  icon: IconName;
}

/** Sidebar order, top group. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { label: 'Discover', path: '/discover', icon: 'discover' },
  { label: 'Search', path: '/search', icon: 'search' },
  { label: 'Library', path: '/library', icon: 'library' },
  { label: 'Activity', path: '/activity', icon: 'activity' },
];

/** Pinned to the bottom of the sidebar. */
export const SECONDARY_NAV: readonly NavItem[] = [
  { label: 'Settings', path: '/settings', icon: 'settings' },
];

/** Mobile tab bar: the first four primary items, then More for the rest. */
export const TAB_NAV: readonly NavItem[] = [
  ...PRIMARY_NAV.slice(0, 4),
  { label: 'More', path: '/more', icon: 'more' },
];

/** Items reachable from the mobile More tab. */
export const MORE_NAV: readonly NavItem[] = [...PRIMARY_NAV.slice(4), ...SECONDARY_NAV];
