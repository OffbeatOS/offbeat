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
  /** When that temporary password stops working; null once they chose their own. */
  temporaryPasswordExpiresAt: string | null;
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
  expiresAt: string;
}

/** How long a temporary password works; after that an admin makes a new one. */
export const TEMPORARY_PASSWORD_DAYS = 7;

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

/** How someone is signed in right now. */
export type SignInVia = 'password' | 'proxy' | 'auto-login';

/** `GET /auth/me`. */
export interface MeResponse {
  user: CurrentUser | null;
  via: SignInVia | null;
  /** Where Sign out should go (a reverse proxy's own sign-out page), when signed in through the proxy. */
  signOutUrl: string | null;
  /** The proxy vouched for this username, but no Offbeat account has it (and auto-create is off). */
  unknownProxyUser: string | null;
}

/** Settings, Users, Sign-in (admins only). */
export interface SignInSettings {
  /** Username and password sign-in for Members. Admins can always use it. */
  localAccounts: boolean;
  proxy: {
    enabled: boolean;
    /** The header the proxy puts the username in. */
    header: string;
    /** Addresses or CIDR ranges of the proxies allowed to send it. Empty means the header is always ignored. */
    trustedProxies: string[];
    /** Create unknown usernames as Members with the default permissions (never admins). */
    autoCreate: boolean;
    /** The proxy's sign-out page, so Sign out does not sign you straight back in. */
    logoutUrl: string | null;
    /** Header carrying the shared secret the proxy adds to every request. */
    secretHeader: string;
    /**
     * The shared secret (recommended): when set, the username only counts if
     * the proxy also sent this value. Never sent to the browser. On save: a
     * string sets it, "" clears it, and null keeps the saved one.
     */
    secret: string | null;
  };
  autoLogin: {
    enabled: boolean;
    /** The Member everyone on these networks is signed in as. Never an admin. */
    userId: number | null;
    /** Addresses or CIDR ranges counted as the local network. */
    networks: string[];
  };
}

/** `GET /settings/sign-in`: the settings, and what Offbeat sees of this request, to help fill them in. */
export interface SignInSettingsView extends SignInSettings {
  /** The address this request came from, as Offbeat sees it (through trusted proxies). */
  yourAddress: string | null;
  /** In Docker, addresses that can stand for anyone (the bridge gateway, Docker Desktop's gateway), so never count as local. */
  dockerAddresses: string[];
  /** A proxy shared secret is saved (its value is never sent back). */
  proxySecretSet: boolean;
}

export const DEFAULT_SIGN_IN: SignInSettings = {
  localAccounts: true,
  proxy: {
    enabled: false,
    header: 'Remote-User',
    trustedProxies: [],
    autoCreate: false,
    logoutUrl: null,
    secretHeader: 'X-Offbeat-Proxy-Secret',
    secret: null,
  },
  autoLogin: { enabled: false, userId: null, networks: [] },
};
