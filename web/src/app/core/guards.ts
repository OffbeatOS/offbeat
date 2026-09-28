import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { Session } from './session';

/** True for an admin who still has setup steps to finish (Lidarr is required). */
function adminNeedsSetup(session: Session): boolean {
  return session.user()?.role === 'admin' && !session.lidarrConfigured();
}

/**
 * The app shell: first run goes to onboarding, signed-out visitors sign in,
 * and an admin without Lidarr finishes setup first.
 */
export const signedInGuard: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureLoaded();

  if (session.needsAdmin()) return router.parseUrl('/onboarding');
  if (!session.user()) {
    return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
  }
  if (session.user()!.mustChangePassword) return router.parseUrl('/change-password');
  if (adminNeedsSetup(session)) return router.parseUrl('/onboarding');
  return true;
};

/** Choosing a password: only for someone signed in with a temporary one. */
export const passwordChangeGuard: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureLoaded();
  if (!session.user()) return router.parseUrl('/login');
  return session.user()!.mustChangePassword ? true : router.parseUrl('/discover');
};

/** Admin-only settings sections; Members land on the sections that are theirs. */
export const adminGuard: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router); // before the await: inject only works synchronously
  await session.ensureLoaded();
  return session.user()?.role === 'admin' ? true : router.parseUrl('/settings/discovery');
};

/** Onboarding covers the first run and any setup steps an admin has not finished. */
export const onboardingGuard: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureLoaded();

  if (session.needsAdmin() || adminNeedsSetup(session)) return true;
  return router.parseUrl(session.user() ? '/discover' : '/login');
};

/** Sign-in page: skipped when already signed in or before an admin exists. */
export const signedOutGuard: CanActivateFn = async (route) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureLoaded();

  if (session.needsAdmin()) return router.parseUrl('/onboarding');
  if (session.user()) return router.parseUrl(safeReturnUrl(route.queryParamMap.get('returnUrl')));
  return true;
};

/** Only follow in-app paths, never another origin. */
export function safeReturnUrl(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/discover';
}
