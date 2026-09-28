import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Session } from './session';

/**
 * Sends the user to sign in when the session expires mid-use. A 403 means
 * the server refused something this user may no longer do (an admin changed
 * their role or permissions): the session is refreshed so the page catches up.
 */
export const unauthorizedInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(Session);
  const router = inject(Router);

  return next(request).pipe(
    catchError((error: unknown) => {
      const isAuthCall = request.url.includes('api/v1/auth/');
      if (error instanceof HttpErrorResponse && error.status === 401 && !isAuthCall) {
        session.signedOut();
        void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
      }
      if (error instanceof HttpErrorResponse && error.status === 403 && !isAuthCall) void session.refresh();
      return throwError(() => error);
    }),
  );
};
