import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { TitleStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { OffbeatTitleStrategy } from './core/title-strategy';
import { unauthorizedInterceptor } from './core/unauthorized.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch(), withInterceptors([unauthorizedInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
    { provide: TitleStrategy, useClass: OffbeatTitleStrategy },
  ],
};
