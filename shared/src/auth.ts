/** `user` is shown as Member. */
export type UserRole = 'admin' | 'user';

/** What a Member may do beyond browsing; admins can do everything. */
export type Permission = 'add-artists' | 'add-albums' | 'change-monitoring' | 'delete' | 'flows';

export const PERMISSIONS: readonly Permission[] = ['add-artists', 'add-albums', 'change-monitoring', 'delete', 'flows'];

/** What a new Member gets unless the admin chooses otherwise. */
export const DEFAULT_MEMBER_PERMISSIONS: readonly Permission[] = ['add-albums'];

/** The signed-in user, from `GET /auth/me`, login, and admin setup. */
export interface CurrentUser {
  id: number;
  username: string;
  role: UserRole;
  /** Everything for admins. */
  permissions: Permission[];
  /** Signed in with a temporary password: nothing else works until they choose their own. */
  mustChangePassword: boolean;
}

/** A user as Settings, Users lists them (admins only). */
export interface UserSummary {
  id: number;
  username: string;
  role: UserRole;
  /** As saved; admins can do everything regardless. */
  permissions: Permission[];
  createdAt: string;
  /** Null until they first sign in. */
  lastSeenAt: string | null;
  /** Still has a temporary password from an admin. */
  mustChangePassword: boolean;
}

/** `POST /users`. Offbeat makes a temporary password; the user chooses their own at first sign-in. */
export interface CreateUserRequest {
  username: string;
  role: UserRole;
  permissions: Permission[];
}

/** A temporary password, shown once: `POST /users` and `POST /users/:id/password`. */
export interface TemporaryPassword {
  temporaryPassword: string;
}

export interface CreatedUser extends TemporaryPassword {
  user: UserSummary;
}

/** `PATCH /users/:id`. */
export interface UpdateUserRequest {
  role?: UserRole;
  permissions?: Permission[];
}

/** `PUT /account/password`: required after signing in with a temporary password. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
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
