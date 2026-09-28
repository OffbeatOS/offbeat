import { Injectable, inject, signal } from '@angular/core';
import type { ChangePasswordRequest, CreateAdminRequest, CurrentUser, LoginRequest, Permission, SetupState } from '@offbeat/shared';
import { Api } from './api';

/** Who is signed in, and whether first-run setup still needs an admin. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private loading: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshedAt = 0;

  readonly user = signal<CurrentUser | null>(null);
  readonly needsAdmin = signal(false);
  /** Admins are sent back to onboarding until this is true. */
  readonly lidarrConfigured = signal(false);
  /** Set when the server could not be reached; the sign-in page explains it. */
  readonly unreachable = signal(false);

  /**
   * Whether the signed-in user may do this (admins may do everything). The
   * server enforces it too; this only keeps buttons it would refuse off the page.
   */
  readonly can = (permission: Permission): boolean => {
    const user = this.user();
    return !!user && (user.role === 'admin' || user.permissions.includes(permission));
  };

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

  /** Replaces the password; also how a temporary one is traded for the user's own. */
  async changePassword(request: ChangePasswordRequest): Promise<void> {
    await this.api.put('account/password', request);
    this.user.update((u) => (u ? { ...u, mustChangePassword: false } : u));
  }

  async logout(): Promise<void> {
    await this.api.post('auth/logout');
    this.user.set(null);
  }

  /**
   * Asks the server who is signed in now: an admin may have changed this
   * user's role or permissions (or reset their password) since the page
   * loaded. `minGapMs` skips it if one ran that recently.
   */
  refresh(minGapMs = 0): Promise<void> {
    if (!this.user() || Date.now() - this.refreshedAt < minGapMs) return Promise.resolve();
    this.refreshing ??= this.api
      .get<{ user: CurrentUser | null }>('auth/me')
      .then((me) => {
        this.refreshedAt = Date.now();
        this.user.set(me.user);
      })
      .catch(() => undefined)
      .finally(() => (this.refreshing = null));
    return this.refreshing;
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
      this.lidarrConfigured.set(state.lidarrConfigured);
      this.user.set(me.user);
      this.unreachable.set(false);
    } catch {
      this.unreachable.set(true);
      this.loading = null; // retry on the next navigation
    }
  }
}
