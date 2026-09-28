import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { TEMPORARY_PASSWORD_DAYS } from '@offbeat/shared';

/** argon2id with the library defaults (OWASP recommended parameters). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

// Verifying against a throwaway hash when the user does not exist keeps
// response times the same, so login cannot be used to probe usernames.
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
  if (passwordHash === null) {
    dummyHash ??= hash('offbeat-timing-equalizer');
    await verify(await dummyHash, password);
    return false;
  }
  return verify(passwordHash, password);
}

// No 0/o, 1/l/i: easy to read out or type from a screen.
const TEMPORARY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A one-time password an admin hands over, like `k7mp-x3qa-9vte-h2wd` (about 79 bits). */
export function temporaryPassword(): string {
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => TEMPORARY_ALPHABET[randomInt(TEMPORARY_ALPHABET.length)]).join(''),
  );
  return groups.join('-');
}

/** A temporary password with its hash and expiry, for adding a user or resetting a password (UI or CLI). */
export async function issueTemporaryPassword(now = new Date()) {
  const password = temporaryPassword();
  return {
    password,
    passwordHash: await hashPassword(password),
    // Whole seconds, as the database stores them, so what the admin is told matches what is saved.
    expiresAt: new Date(Math.floor(now.getTime() / 1000) * 1000 + TEMPORARY_PASSWORD_DAYS * 86_400_000),
  };
}
