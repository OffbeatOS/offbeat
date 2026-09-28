/** `user` is shown as Member. */
export type UserRole = 'admin' | 'user';

/** What a Member may do beyond browsing; admins can do everything. */
export type Permission = 'add-artists' | 'add-albums' | 'change-monitoring' | 'delete' | 'flows';

export const PERMISSIONS: readonly Permission[] = ['add-artists', 'add-albums', 'change-monitoring', 'delete', 'flows'];

/** What a new Member gets unless the admin chooses otherwise. */
export const DEFAULT_MEMBER_PERMISSIONS: readonly Permission[] = ['add-artists', 'add-albums'];

/** The signed-in user, from `GET /auth/me`, login, and admin setup. */
export interface CurrentUser {
  id: number;
  username: string;
  role: UserRole;
  /** Everything for admins. */
  permissions: Permission[];
}

/** A user as Settings, Users lists them (admins only). */
export interface UserSummary {
  id: number;
  username: string;
  role: UserRole;
  /** As saved; admins can do everything regardless. */
  permissions: Permission[];
  createdAt: string;
}

/** `POST /users`. */
export interface CreateUserRequest {
  username: string;
  password: string;
  role: UserRole;
  permissions: Permission[];
}

/** `PATCH /users/:id`. */
export interface UpdateUserRequest {
  role?: UserRole;
  permissions?: Permission[];
}

/** `POST /users/:id/password`: sets a new password and signs the user out everywhere. */
export interface ResetPasswordRequest {
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/** Response of `GET /setup/state`. Public, so the web app can route before login. */
export interface SetupState {
  /** True until the first admin account exists; the app sends everyone to onboarding. */
  needsAdmin: boolean;
  /** False until an admin saves a working Lidarr connection; admins are sent back to onboarding. */
  lidarrConfigured: boolean;
}

export interface CreateAdminRequest {
  username: string;
  password: string;
}

/** Shared validation rules so the form and the server agree. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
