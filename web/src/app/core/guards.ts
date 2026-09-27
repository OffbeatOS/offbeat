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
  if (adminNeedsSetup(session)) return router.parseUrl('/onboarding');
  return true;
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
