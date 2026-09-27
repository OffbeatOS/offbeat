import type { Route, Routes } from '@angular/router';
import { onboardingGuard, signedInGuard, signedOutGuard } from './core/guards';
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

const settingsPlaceholder = (path: string, heading: string, description: string): Route => ({
  path,
  title: `${heading} settings`,
  loadComponent: () =>
    import('./features/settings/settings-placeholder').then((m) => m.SettingsPlaceholder),
  data: { heading, description },
});

export const routes: Routes = [
  {
    path: 'onboarding',
    title: 'Set up',
    canActivate: [onboardingGuard],
    loadComponent: () =>
      import('./features/onboarding/onboarding-page').then((m) => m.OnboardingPage),
  },
  {
    path: 'login',
    title: 'Sign in',
    canActivate: [signedOutGuard],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    // Everything signed in lives inside the shell, which stays mounted across pages.
    path: '',
    canActivate: [signedInGuard],
    loadComponent: () => import('./shared/shell/shell-layout').then((m) => m.ShellLayout),
    children: [
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
      placeholder('flows', 'Flows', 'flows', 'No flows yet', 'Scheduled discovery playlists will live here.'),
      placeholder(
        'shows',
        'Shows',
        'shows',
        'No shows yet',
        'Upcoming concerts for artists you follow will appear here.',
      ),
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings-layout').then((m) => m.SettingsLayout),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'integrations' },
          {
            path: 'integrations',
            title: 'Integrations settings',
            loadComponent: () =>
              import('./features/settings/integrations-settings').then((m) => m.IntegrationsSettings),
          },
          {
            path: 'integrations/lidarr',
            title: 'Lidarr settings',
            loadComponent: () =>
              import('./features/settings/lidarr-settings').then((m) => m.LidarrSettings),
          },
          settingsPlaceholder('discovery', 'Discovery', 'How recommendations are chosen and refreshed.'),
          settingsPlaceholder('users', 'Users', 'People who can use this Offbeat server.'),
          {
            path: 'account',
            title: 'Account settings',
            loadComponent: () =>
              import('./features/settings/account-settings').then((m) => m.AccountSettings),
          },
          settingsPlaceholder('notifications', 'Notifications', 'Where Offbeat sends alerts.'),
          settingsPlaceholder('about', 'About', 'Version and project information.'),
        ],
      },
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
    ],
  },
];
