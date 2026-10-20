// single-user tool, public internet once deployed — a simple in-memory counter per IP is
// enough to stop casual brute-forcing without pulling in a dependency or a DB table.
function makeRateLimiter(maxAttempts: number, lockMs: number) {
  const attempts = new Map<string, { count: number; lockedUntil: number }>();
  return {
    check(key: string): { allowed: boolean; retryAfterMs?: number } {
      const entry = attempts.get(key);
      if (entry && entry.lockedUntil > Date.now()) return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
      return { allowed: true };
    },
    recordFailure(key: string) {
      const entry = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
      entry.count++;
      if (entry.count >= maxAttempts) {
        entry.lockedUntil = Date.now() + lockMs;
        entry.count = 0;
      }
      attempts.set(key, entry);
    },
    recordSuccess(key: string) {
      attempts.delete(key);
    },
  };
}

const login = makeRateLimiter(5, 5 * 60_000);
export const loginRateLimit = login.check;
export const recordLoginFailure = login.recordFailure;
export const recordLoginSuccess = login.recordSuccess;

// /ws/runner takes a bearer token in the query string — same shape of risk as a login form,
// so it gets the same lockout: 5 bad tokens from one IP locks that IP out for 5 minutes.
const wsRunner = makeRateLimiter(5, 5 * 60_000);
export const wsRunnerRateLimit = wsRunner.check;
export const recordWsRunnerFailure = wsRunner.recordFailure;
