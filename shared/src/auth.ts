export type UserRole = 'admin' | 'user';

/** The signed-in user, from `GET /auth/me`, login, and admin setup. */
export interface CurrentUser {
  id: number;
  username: string;
  role: UserRole;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/** Response of `GET /setup/state`. Public, so the web app can route before login. */
export interface SetupState {
  /** True until the first admin account exists; the app sends everyone to onboarding. */
  needsAdmin: boolean;
}

export interface CreateAdminRequest {
  username: string;
  password: string;
}

/** Shared validation rules so the form and the server agree. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
