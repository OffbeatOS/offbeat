import type { Route, Routes } from '@angular/router';
import { adminGuard, noAccountGuard, onboardingGuard, passwordChangeGuard, signedInGuard, signedOutGuard } from './core/guards';
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
    path: 'no-account',
    title: 'No account',
    canActivate: [noAccountGuard],
    loadComponent: () => import('./features/auth/no-account-page').then((m) => m.NoAccountPage),
  },
  {
    path: 'change-password',
    title: 'Choose your password',
    canActivate: [passwordChangeGuard],
    loadComponent: () =>
      import('./features/auth/change-password-page').then((m) => m.ChangePasswordPage),
  },
  {
    // Everything signed in lives inside the shell, which stays mounted across pages.
    path: '',
    canActivate: [signedInGuard],
    loadComponent: () => import('./shared/shell/shell-layout').then((m) => m.ShellLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'discover' },
      {
        path: 'discover',
        title: 'Discover',
        loadComponent: () => import('./features/discover/discover-page').then((m) => m.DiscoverPage),
      },
      {
        path: 'tag/:tag',
        title: 'Tag',
        loadComponent: () => import('./features/tag/tag-page').then((m) => m.TagPage),
      },
      {
        path: 'search',
        title: 'Search',
        loadComponent: () => import('./features/search/search-page').then((m) => m.SearchPage),
      },
      {
        path: 'library',
        title: 'Library',
        loadComponent: () => import('./features/library/library-page').then((m) => m.LibraryPage),
      },
      {
        path: 'artist/:mbid',
        title: 'Artist',
        loadComponent: () => import('./features/artist/artist-page').then((m) => m.ArtistPage),
      },
      {
        path: 'album/:mbid',
        title: 'Album',
        loadComponent: () => import('./features/album/album-page').then((m) => m.AlbumPage),
      },
      {
        path: 'activity',
        title: 'Activity',
        loadComponent: () => import('./features/activity/activity-page').then((m) => m.ActivityPage),
      },
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
            canActivate: [adminGuard],
            loadComponent: () =>
              import('./features/settings/integrations-settings').then((m) => m.IntegrationsSettings),
          },
          {
            path: 'integrations/lidarr',
            title: 'Lidarr settings',
            canActivate: [adminGuard],
            loadComponent: () =>
              import('./features/settings/lidarr-settings').then((m) => m.LidarrSettings),
          },
          {
            path: 'integrations/lastfm',
            title: 'Last.fm settings',
            canActivate: [adminGuard],
            loadComponent: () =>
              import('./features/settings/lastfm-settings').then((m) => m.LastfmSettings),
          },
          {
            path: 'discovery',
            title: 'Discovery settings',
            loadComponent: () =>
              import('./features/settings/discovery-settings').then((m) => m.DiscoverySettings),
          },
          {
            path: 'users',
            title: 'Users',
            canActivate: [adminGuard],
            loadComponent: () => import('./features/settings/users-settings').then((m) => m.UsersSettings),
          },
          {
            path: 'account',
            title: 'Account settings',
            loadComponent: () =>
              import('./features/settings/account-settings').then((m) => m.AccountSettings),
          },
          {
            path: 'notifications',
            title: 'Notifications',
            canActivate: [adminGuard],
            loadComponent: () =>
              import('./features/settings/notifications-settings').then((m) => m.NotificationsSettings),
          },
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
