// single-user tool, public internet once deployed — a simple in-memory counter per IP is
// enough to stop casual brute-forcing without pulling in a dependency or a DB table.
const attempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

export function loginRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const entry = attempts.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip: string) {
  const entry = attempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_MS;
    entry.count = 0;
  }
  attempts.set(ip, entry);
}

export function recordLoginSuccess(ip: string) {
  attempts.delete(ip);
}
