import { sql } from "./db.ts";
import { getIssueById } from "./cache.ts";

// shared by tools.ts (voice-facing reads) and runner-link.ts (the proactive catch-up callback)
// — kept in its own module so neither has to import the other.
export async function liveBlockedJobs() {
  const rows = await sql`select id, ticket_id, title, question, surfaced_at from jobs where status = 'blocked' order by finished_at desc`;
  // reproduced live: the same ticket_id can have several historical 'blocked' rows (repeat
  // testing, resumed-then-reblocked, etc.) — without deduplicating, a ticket could get counted
  // and spoken about twice in the same breath. Keep only the most recent row per ticket_id
  // (rows are already ordered finished_at desc, so the first one seen per ticket_id wins).
  const latestPerTicket = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latestPerTicket.has(r.ticket_id)) latestPerTicket.set(r.ticket_id, r);
  const checked = await Promise.all(
    [...latestPerTicket.values()].map(async (r) => {
      const issue = await getIssueById(r.ticket_id).catch(() => undefined);
      // Linear is the real source of truth for "is this still open" — no issue found
      // (deleted/archived), or no longer in a started-type state (completed, cancelled, or
      // reset back to todo some other way), and the question is moot regardless of what our
      // own jobs.status column still says.
      return issue && issue.state?.type === "started" ? r : null;
    }),
  );
  return checked.filter((r) => r !== null);
}
