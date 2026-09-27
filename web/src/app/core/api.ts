import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { ApiErrorBody } from '@offbeat/shared';
import { type Observable, firstValueFrom } from 'rxjs';

/** A failed API call, carrying the server's user-facing message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function toApiError(error: unknown): never {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) throw new ApiError(0, 'Could not reach the Offbeat server.');
    const body = error.error as Partial<ApiErrorBody> | null;
    throw new ApiError(error.status, body?.message ?? error.statusText ?? 'Request failed');
  }
  throw error;
}

/**
 * Thin promise wrapper over HttpClient. Paths are relative to `<base href>`,
 * so the app works unchanged under a BASE_URL subpath.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  get<T>(path: string): Promise<T> {
    return this.send(this.http.get<T>(`api/v1/${path}`));
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.send(this.http.post<T>(`api/v1/${path}`, body));
  }

  put<T>(path: string, body: unknown = {}): Promise<T> {
    return this.send(this.http.put<T>(`api/v1/${path}`, body));
  }

  patch<T>(path: string, body: unknown = {}): Promise<T> {
    return this.send(this.http.patch<T>(`api/v1/${path}`, body));
  }

  /** DELETE with a JSON body, since the API requires JSON on every write. */
  delete<T>(path: string): Promise<T> {
    return this.send(this.http.delete<T>(`api/v1/${path}`, { body: {} }));
  }

  private send<T>(request: Observable<T>): Promise<T> {
    return firstValueFrom(request).catch(toApiError);
  }
}
