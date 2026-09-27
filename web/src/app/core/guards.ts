import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { Session } from './session';

/** The app shell: first run goes to onboarding, everyone else must sign in. */
export const signedInGuard: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureLoaded();

  if (session.needsAdmin()) return router.parseUrl('/onboarding');
  if (!session.user()) {
    return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
  }
  return true;
};

/** Onboarding is only for the first run (and, later, unfinished setup steps). */
export const onboardingGuard: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureLoaded();

  if (session.needsAdmin()) return true;
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
