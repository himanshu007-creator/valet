// in-memory only, deliberately — this is operational telemetry for the dashboard's p50/p95
// panel, not a record anyone needs to survive a restart. A ring buffer per tool name.
const MAX_SAMPLES = 200;
const buffers = new Map<string, number[]>();

export function recordLatency(tool: string, ms: number) {
  const arr = buffers.get(tool) ?? [];
  arr.push(ms);
  if (arr.length > MAX_SAMPLES) arr.shift();
  buffers.set(tool, arr);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return Math.round(sorted[Math.floor(p * (sorted.length - 1))]);
}

export function getStats() {
  const out: Record<string, { count: number; p50: number; p95: number }> = {};
  for (const [tool, arr] of buffers) {
    const sorted = [...arr].sort((a, b) => a - b);
    out[tool] = { count: arr.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
  }
  return out;
}

export async function timed<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    recordLatency(tool, Date.now() - start);
  }
}
