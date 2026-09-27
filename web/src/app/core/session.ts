import { Injectable, inject, signal } from '@angular/core';
import type { CreateAdminRequest, CurrentUser, LoginRequest, SetupState } from '@offbeat/shared';
import { Api } from './api';

/** Who is signed in, and whether first-run setup still needs an admin. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private loading: Promise<void> | null = null;

  readonly user = signal<CurrentUser | null>(null);
  readonly needsAdmin = signal(false);
  /** Set when the server could not be reached; the sign-in page explains it. */
  readonly unreachable = signal(false);

  /** Loads session state once; guards await this before deciding where to route. */
  ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  async login(request: LoginRequest): Promise<void> {
    this.user.set(await this.api.post<CurrentUser>('auth/login', request));
  }

  async createAdmin(request: CreateAdminRequest): Promise<void> {
    this.user.set(await this.api.post<CurrentUser>('setup/admin', request));
    this.needsAdmin.set(false);
  }

  async logout(): Promise<void> {
    await this.api.post('auth/logout');
    this.user.set(null);
  }

  /** Called when any request comes back 401, for example after the session expired. */
  signedOut(): void {
    this.user.set(null);
  }

  private async load(): Promise<void> {
    try {
      const [state, me] = await Promise.all([
        this.api.get<SetupState>('setup/state'),
        this.api.get<{ user: CurrentUser | null }>('auth/me'),
      ]);
      this.needsAdmin.set(state.needsAdmin);
      this.user.set(me.user);
      this.unreachable.set(false);
    } catch {
      this.unreachable.set(true);
      this.loading = null; // retry on the next navigation
    }
  }
}
