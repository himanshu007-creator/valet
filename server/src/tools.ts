import { getPrioritiesSummary, getIssueById } from "./cache.ts";
import { sql } from "./db.ts";
import { runnerConnected, dispatchJob, dispatchAnswer, dispatchImplement } from "./runner-link.ts";
import { broadcastStatus } from "./dashboard-link.ts";

// shared by the Bolna phone tools (HTTP) and desk mode's local tool-calling loop —
// one implementation, two callers, so neither drifts from the other.

export async function toolGetPriorities(): Promise<string> {
  return getPrioritiesSummary();
}

export async function toolOrder(ticketsArg: string): Promise<string> {
  const ids = (ticketsArg ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (ids.length === 0) return "I didn't catch which tickets to start on.";
  if (!runnerConnected()) return "The runner on your Mac isn't connected right now, so I can't start that.";

  const issues = await Promise.all(ids.map((id) => getIssueById(id)));
  const found = issues.filter((i) => i !== undefined);
  if (found.length === 0) return "I couldn't find those tickets on the board.";

  const [order] = await sql`insert into orders (tickets) values (${found.map((i) => i!.identifier)}) returning id`;
  for (const issue of found) {
    const [job] = await sql`
      insert into jobs (order_id, ticket_id, title, status)
      values (${order.id}, ${issue!.identifier}, ${issue!.title}, 'queued')
      returning id
    `;
    dispatchJob(job.id, { id: issue!.identifier, title: issue!.title, description: issue!.description ?? "" });
  }
  broadcastStatus();
  return `Starting on ${found.length} thing${found.length > 1 ? "s" : ""}. I'll call you when they're done.`;
}

export async function toolGetStatus(): Promise<string> {
  const [order] = await sql`select id from orders order by created_at desc limit 1`;
  if (!order) return "Nothing running right now.";
  const jobs = await sql`select status, title from jobs where order_id = ${order.id}`;
  const running = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const done = jobs.filter((j) => j.status === "done").length;
  const blocked = jobs.filter((j) => j.status === "blocked").length;
  const errored = jobs.filter((j) => j.status === "failed" || j.status === "timeout").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} still running`);
  if (done > 0) parts.push(`${done} done`);
  if (blocked > 0) parts.push(`${blocked} waiting on a decision from you`);
  if (errored > 0) parts.push(`${errored} hit an error`);
  return parts.length > 0 ? parts.join(", ") + "." : "Nothing running right now.";
}

export async function toolAnswerQuestion(answer: string): Promise<string> {
  if (!answer) return "I didn't catch an answer.";
  const [job] = await sql`select id from jobs where status = 'blocked' order by finished_at desc limit 1`;
  if (!job) return "There's nothing waiting on an answer right now.";
  await sql`update jobs set answer = ${answer} where id = ${job.id}`;
  await dispatchAnswer(job.id, answer);
  broadcastStatus();
  return "Got it, I'll pass that along.";
}

export async function toolImplement(ticketArg: string): Promise<string> {
  const ticketId = ticketArg.trim();
  if (!ticketId) return "I didn't catch which ticket.";
  if (!runnerConnected()) return "The runner on your Mac isn't connected right now, so I can't start that.";

  const [job] = await sql`select id, title, pr_url from jobs where ticket_id = ${ticketId} and status = 'done' order by finished_at desc limit 1`;
  if (!job) return "I don't have a finished research pass for that ticket yet — order it first.";

  await sql`update jobs set status = 'queued' where id = ${job.id}`;
  dispatchImplement(job.id, { id: ticketId, title: job.title, description: "" });
  broadcastStatus();
  return `Starting the real implementation for ${job.title}. I'll call you when it's ready.`;
}
