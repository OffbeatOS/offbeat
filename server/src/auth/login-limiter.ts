/**
 * Slows password guessing: after `maxFailures` failed logins from one address
 * inside `windowMs`, further attempts are refused until the window ends.
 * In memory on purpose; Offbeat is a single process.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** Seconds until `key` may try again, or 0 when it is allowed now. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.maxFailures ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()) {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
    } else {
      entry.count += 1;
    }
  }

  succeed(key: string) {
    this.failures.delete(key);
  }

  private prune(now: number) {
    for (const [key, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(key);
    }
  }
}
