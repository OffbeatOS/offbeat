import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import {
  type CreatedUser,
  DEFAULT_MEMBER_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  TEMPORARY_PASSWORD_DAYS,
  type TemporaryPassword,
  USERNAME_PATTERN,
  type UserRole,
  type UserSummary,
} from '@offbeat/shared';
import { Api, ApiError } from '../../core/api';
import { Session } from '../../core/session';
import { avatarColor } from '../../shared/avatar';
import { timeAgo } from '../../shared/format';
import { Icon } from '../../shared/icon/icon';
import { SignInSettingsPanel } from './sign-in-settings';

export const PERMISSION_LABEL: Record<Permission, string> = {
  stream: 'Stream music',
  'add-artists': 'Add artists',
  'add-albums': 'Add albums',
  'change-monitoring': 'Change monitoring',
  delete: 'Delete from Lidarr',
  flows: 'Use Flows',
};

/** What the side panel shows. */
type Panel =
  | { kind: 'user'; id: number }
  | { kind: 'add' }
  | { kind: 'password'; username: string; password: string; expiresAt: string; created: boolean; then: number };

/** The editable part of a user, as the panel holds it until Save. */
interface Draft {
  role: UserRole;
  permissions: Permission[];
}

/** Whether their temporary password has run out (they cannot sign in with it any more). */
export function temporaryExpired(user: UserSummary, now = Date.now()): boolean {
  return user.mustChangePassword && !!user.temporaryPasswordExpiresAt && Date.parse(user.temporaryPasswordExpiresAt) <= now;
}

/** "You, active now", "Active 2 hours ago", "Invited, not signed in yet", "Invite expired". */
export function activityLine(user: UserSummary, meId: number | undefined, now = Date.now()): string {
  if (user.id === meId) return 'You, active now';
  if (!user.lastSeenAt) return temporaryExpired(user, now) ? 'Invite expired' : 'Invited, not signed in yet';
  const days = Math.floor((now - Date.parse(user.lastSeenAt)) / 86_400_000);
  if (days === 1) return 'Active yesterday';
  const ago = timeAgo(user.lastSeenAt, now);
  return ago === 'just now' ? 'Active now' : `Active ${ago}`;
}

/**
 * Settings, Users (SettingsUsers mockup): who can use Offbeat and what they
 * can do. Admins never choose passwords for other people: adding someone or
 * resetting their password shows a temporary one, once, which they replace
 * when they sign in.
 */
@Component({
  selector: 'ob-users-settings',
  imports: [NgTemplateOutlet, Icon, SignInSettingsPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './users-settings.html',
  styleUrl: './users-settings.scss',
})
export class UsersSettings implements OnInit {
  private readonly api = inject(Api);
  protected readonly session = inject(Session);

  protected readonly days = TEMPORARY_PASSWORD_DAYS;
  // Flows is not built yet (see ROADMAP, Later). The permission stays in each user's data, just not on screen.
  protected readonly permissions = PERMISSIONS.filter((p) => p !== 'flows');
  protected readonly label = PERMISSION_LABEL;
  protected readonly color = avatarColor;
  protected readonly users = signal<UserSummary[] | null>(null);
  protected readonly panel = signal<Panel | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly newName = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly confirmRemove = signal(false);
  protected readonly copied = signal(false);

  protected readonly me = computed(() => this.session.user()?.id);
  protected readonly selected = computed(() => {
    const panel = this.panel();
    return panel?.kind === 'user' ? (this.users()?.find((u) => u.id === panel.id) ?? null) : null;
  });
  private readonly adminCount = computed(() => this.users()?.filter((u) => u.role === 'admin').length ?? 0);
  /** The only admin: cannot be made a Member or removed. */
  protected readonly lastAdmin = computed(() => this.selected()?.role === 'admin' && this.adminCount() <= 1);
  protected readonly dirty = computed(() => {
    const user = this.selected();
    const draft = this.draft();
    return !!user && !!draft && (user.role !== draft.role || user.permissions.join() !== draft.permissions.join());
  });

  async ngOnInit() {
    await this.load();
    const first = this.users()?.find((u) => u.id !== this.me()) ?? this.users()?.[0];
    if (first) this.select(first);
  }

  protected line(user: UserSummary): string {
    return activityLine(user, this.me());
  }

  /** For someone still on a temporary password: until when it works, or that it no longer does. */
  protected temporaryNote(user: UserSummary): string {
    if (!user.mustChangePassword || !user.temporaryPasswordExpiresAt) return '';
    if (temporaryExpired(user)) return 'Their temporary password expired. Reset Password makes a new one.';
    const until = new Date(user.temporaryPasswordExpiresAt).toLocaleDateString([], { month: 'long', day: 'numeric' });
    return `Waiting for them to sign in with their temporary password, which works until ${until}.`;
  }

  protected joined(user: UserSummary): string {
    return `Joined ${new Date(user.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })}`;
  }

  protected select(user: UserSummary) {
    this.panel.set({ kind: 'user', id: user.id });
    this.draft.set({ role: user.role, permissions: [...user.permissions] });
    this.error.set('');
    this.confirmRemove.set(false);
  }

  protected startAdd() {
    this.panel.set({ kind: 'add' });
    this.draft.set({ role: 'user', permissions: [...DEFAULT_MEMBER_PERMISSIONS] });
    this.newName.set('');
    this.error.set('');
    this.confirmRemove.set(false);
  }

  protected setRole(role: UserRole) {
    this.draft.update((d) => (d ? { ...d, role } : d));
  }

  protected togglePermission(permission: Permission) {
    this.draft.update((d) => {
      if (!d) return d;
      const has = d.permissions.includes(permission);
      const next = has ? d.permissions.filter((p) => p !== permission) : [...d.permissions, permission];
      return { ...d, permissions: PERMISSIONS.filter((p) => next.includes(p)) };
    });
  }

  protected async add() {
    const draft = this.draft();
    const username = this.newName().trim();
    this.error.set('');
    if (!USERNAME_PATTERN.test(username)) {
      this.error.set('Use 3 to 32 letters, numbers, dots, dashes, or underscores');
      return;
    }
    if (!draft) return;
    await this.run(async () => {
      const created = await this.api.post<CreatedUser>('users', { username, ...draft });
      this.users.update((list) => [...(list ?? []), created.user]);
      this.showPassword(created.user.username, created.temporaryPassword, created.expiresAt, true, created.user.id);
    });
  }

  protected async save() {
    const user = this.selected();
    const draft = this.draft();
    if (!user || !draft) return;
    await this.run(async () => {
      const updated = await this.api.patch<UserSummary>(`users/${user.id}`, draft);
      this.users.update((list) => list?.map((u) => (u.id === updated.id ? updated : u)) ?? null);
      this.draft.set({ role: updated.role, permissions: [...updated.permissions] });
    });
  }

  protected async resetPassword() {
    const user = this.selected();
    if (!user) return;
    await this.run(async () => {
      const { temporaryPassword, expiresAt } = await this.api.post<TemporaryPassword>(`users/${user.id}/password`);
      this.users.update(
        (list) =>
          list?.map((u) => (u.id === user.id ? { ...u, mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt } : u)) ?? null,
      );
      this.showPassword(user.username, temporaryPassword, expiresAt, false, user.id);
    });
  }

  protected async remove() {
    const user = this.selected();
    if (!user) return;
    await this.run(async () => {
      await this.api.delete(`users/${user.id}`);
      const rest = this.users()?.filter((u) => u.id !== user.id) ?? [];
      this.users.set(rest);
      const next = rest.find((u) => u.id !== this.me()) ?? rest[0];
      if (next) this.select(next);
      else this.panel.set(null);
    });
  }

  protected async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      this.error.set('Could not copy. Select the password and copy it yourself.');
    }
  }

  /** Done with a temporary password: back to that user. */
  protected closePassword(userId: number) {
    const user = this.users()?.find((u) => u.id === userId);
    if (user) this.select(user);
  }

  private showPassword(username: string, password: string, expiresAt: string, created: boolean, then: number) {
    this.copied.set(false);
    this.panel.set({ kind: 'password', username, password, expiresAt, created, then });
  }

  private async run(action: () => Promise<void>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      this.busy.set(false);
      this.confirmRemove.set(false);
    }
  }

  private async load() {
    try {
      this.users.set(await this.api.get<UserSummary[]>('users'));
    } catch (error) {
      this.error.set(error instanceof ApiError ? error.message : 'Could not load users');
    }
  }
}
