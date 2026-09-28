/** `admin`: only admins see it (the routes are guarded too). */
export const SETTINGS_SECTIONS = [
  { path: 'integrations', label: 'Integrations', admin: true },
  { path: 'discovery', label: 'Discovery', admin: false },
  { path: 'users', label: 'Users', admin: true },
  { path: 'account', label: 'Account', admin: false },
  { path: 'notifications', label: 'Notifications', admin: false },
  { path: 'about', label: 'About', admin: false },
] as const;
