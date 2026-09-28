import { type CurrentUser, PERMISSIONS, type Permission, type UserRole } from '@offbeat/shared';

/** A stored permissions column (JSON array) as known permissions, in canonical order. */
export function parsePermissions(json: string): Permission[] {
  let saved: unknown;
  try {
    saved = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(saved) ? PERMISSIONS.filter((p) => saved.includes(p)) : [];
}

/** What someone may actually do: admins everything, Members what was granted. */
export function effectivePermissions(role: UserRole, json: string): Permission[] {
  return role === 'admin' ? [...PERMISSIONS] : parsePermissions(json);
}

export function toCurrentUser(row: { id: number; username: string; role: UserRole; permissions: string }): CurrentUser {
  return { id: row.id, username: row.username, role: row.role, permissions: effectivePermissions(row.role, row.permissions) };
}

export function can(user: CurrentUser, permission: Permission): boolean {
  return user.role === 'admin' || user.permissions.includes(permission);
}
