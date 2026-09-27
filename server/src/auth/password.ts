import { hash, verify } from '@node-rs/argon2';

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
