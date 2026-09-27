import type { Route, Routes } from '@angular/router';
import type { IconName } from './shared/icon/icon';

const placeholder = (
  path: string,
  heading: string,
  icon: IconName,
  emptyHeading: string,
  emptyMessage: string,
): Route => ({
  path,
  title: heading,
  loadComponent: () => import('./shared/page/placeholder-page').then((m) => m.PlaceholderPage),
  data: { heading, icon, emptyHeading, emptyMessage },
});

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'discover' },
  placeholder(
    'discover',
    'Discover',
    'discover',
    'No recommendations yet',
    'Picks based on your library will show up here once Lidarr is connected.',
  ),
  placeholder(
    'search',
    'Search',
    'search',
    'Search is not available yet',
    'Find artists and albums to add to your library.',
  ),
  placeholder(
    'library',
    'Library',
    'library',
    'Your library is empty',
    'Artists you add through Lidarr will appear here.',
  ),
  placeholder(
    'activity',
    'Activity',
    'activity',
    'Nothing happening',
    'Requests, downloads, and failures will be listed here.',
  ),
  placeholder(
    'flows',
    'Flows',
    'flows',
    'No flows yet',
    'Scheduled discovery playlists will live here.',
  ),
  placeholder(
    'shows',
    'Shows',
    'shows',
    'No shows yet',
    'Upcoming concerts for artists you follow will appear here.',
  ),
  placeholder(
    'settings',
    'Settings',
    'settings',
    'Nothing to configure yet',
    'Integrations, discovery tuning, and users will be managed here.',
  ),
  {
    path: 'more',
    title: 'More',
    loadComponent: () => import('./features/more/more-page').then((m) => m.MorePage),
  },
  placeholder(
    '**',
    'Not found',
    'alert',
    'This page does not exist',
    'Check the address, or pick a destination from the menu.',
  ),
];
