import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A unique, not yet created directory for the artwork cache in one test. */
export function tmpImageDir(): string {
  return path.join(tmpdir(), `offbeat-test-images-${randomBytes(6).toString('hex')}`);
}
