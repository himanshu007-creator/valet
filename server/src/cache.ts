import { fetchAssignedIssues, type Issue } from "./linear.ts";
import { summarisePriorities } from "./summarise.ts";

// 5 minutes, not 60s: Linear's ticket list rarely changes mid-call, and a live request should
// never have to wait on it — see the stale-while-revalidate pattern below. invalidateIssueCache()
// still forces a hard refresh right after VALET itself creates a ticket (see tools.ts).
const TTL_MS = 5 * 60_000;
let cached: { issues: Issue[]; summary: string; at: number } | null = null;
let inflight: Promise<{ issues: Issue[]; summary: string }> | null = null;

async function refresh() {
  const issues = await fetchAssignedIssues();
  const summary = await summarisePriorities(issues);
  cached = { issues, summary, at: Date.now() };
  return cached;
}

// stale-while-revalidate: a live voice call should never block ~1-4s on a Linear round trip
// just because the TTL ticked over. Serve what's cached (even if stale) immediately, and
// refresh in the background for next time. Only a genuinely cold cache (nothing fetched yet
// this process) blocks the caller — that's unavoidable on the very first request.
function ensureFresh() {
  if (cached && Date.now() - cached.at >= TTL_MS && !inflight) {
    inflight = refresh().finally(() => (inflight = null));
    inflight.catch((err) => console.error("background priorities refresh failed", err));
  }
}

export async function getPrioritiesSummary(): Promise<string> {
  if (cached) {
    ensureFresh();
    return cached.summary;
  }
  if (!inflight) inflight = refresh().finally(() => (inflight = null));
  const result = await inflight;
  return result.summary;
}

// fire-and-forget: called when a call starts so the cache is warm by the time get_priorities fires
export function prefetchPriorities() {
  if (cached && Date.now() - cached.at < TTL_MS) return;
  if (!inflight) inflight = refresh().finally(() => (inflight = null));
  inflight.catch((err) => console.error("prefetch priorities failed", err));
}

export async function getIssueById(ticketId: string): Promise<Issue | undefined> {
  if (!cached) await getPrioritiesSummary();
  else ensureFresh();
  return cached!.issues.find((i) => i.identifier.toLowerCase() === ticketId.toLowerCase());
}

export async function getCachedIssues(): Promise<Issue[]> {
  if (!cached) await getPrioritiesSummary();
  else ensureFresh();
  return cached!.issues;
}

// a just-created issue won't be in the cache until the TTL expires — invalidate immediately
// so a follow-up probe/delete/execute in the same call can still find it. This forces the
// *next* read to block on a fresh fetch (same as a genuinely cold cache) — acceptable since
// it only happens right after VALET itself just created something.
export function invalidateIssueCache() {
  cached = null;
}
