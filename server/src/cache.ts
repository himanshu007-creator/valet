import { fetchAssignedIssues, type Issue } from "./linear.ts";
import { summarisePriorities } from "./summarise.ts";

const TTL_MS = 60_000;
let cached: { issues: Issue[]; summary: string; at: number } | null = null;
let inflight: Promise<{ issues: Issue[]; summary: string }> | null = null;

async function refresh() {
  const issues = await fetchAssignedIssues();
  const summary = await summarisePriorities(issues);
  cached = { issues, summary, at: Date.now() };
  return cached;
}

export async function getPrioritiesSummary(): Promise<string> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.summary;
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
  if (!cached || Date.now() - cached.at >= TTL_MS) await getPrioritiesSummary();
  return cached!.issues.find((i) => i.identifier.toLowerCase() === ticketId.toLowerCase());
}
