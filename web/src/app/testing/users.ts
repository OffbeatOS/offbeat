import { TestBed } from '@angular/core/testing';
import { type CurrentUser, PERMISSIONS } from '@offbeat/shared';
import { Session } from '../core/session';

export const ADMIN: CurrentUser = { id: 1, username: 'admin', role: 'admin', permissions: [...PERMISSIONS], mustChangePassword: false };
export const MEMBER: CurrentUser = { id: 2, username: 'member', role: 'user', permissions: [], mustChangePassword: false };

/** Signs a user in for a spec; call after TestBed.configureTestingModule. */
export function signIn(user: CurrentUser) {
  TestBed.inject(Session).user.set(user);
}
