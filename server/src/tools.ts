import { getPrioritiesSummary, getIssueById, getCachedIssues, invalidateIssueCache } from "./cache.ts";
import { sql } from "./db.ts";
import { runnerConnected, dispatchJob, dispatchAnswer, dispatchImplement } from "./runner-link.ts";
import { broadcastStatus } from "./dashboard-link.ts";
import { createIssue, archiveIssue } from "./linear.ts";
import { classifyAndMatch, matchTicket, BAND } from "./router.ts";
import { env } from "./env.ts";

// shared by the Bolna phone tools (HTTP) and desk mode's local tool-calling loop —
// one implementation, two callers, so neither drifts from the other.

// a reconnect in flight (the runner retries every 3s, and its own heartbeat forces a
// reconnect within a couple missed pings) shouldn't read as "not connected" to the caller —
// retries cover that window without a caller ever noticing, instead of a flat false telling
// them to try again themselves. Reproduced live, twice: first a single 800ms retry wasn't
// enough, then a ~2.1s budget (3 retries) still wasn't enough for a real gap mid-call. Budget
// is now ~6s — comfortably past the runner's own 3s reconnect-retry interval, and the voice
// caller already has Bolna's pre_call_message playing during this wait, so it isn't dead air.
async function runnerConnectedWithRetry(): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    if (runnerConnected()) return true;
    await new Promise((r) => setTimeout(r, 750));
  }
  return runnerConnected();
}

export async function toolGetPriorities(): Promise<string> {
  return getPrioritiesSummary();
}

export async function toolOrder(ticketsArg: string): Promise<string> {
  const ids = (ticketsArg ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (ids.length === 0) return "I didn't catch which tickets to start on.";
  if (!(await runnerConnectedWithRetry())) return "The runner on your Mac isn't connected right now, so I can't start that.";

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

const STATUS_WORDS: Record<string, string> = {
  queued: "queued",
  running: "in progress",
  done: "done",
  blocked: "waiting on a decision from you",
  failed: "hit an error",
  timeout: "timed out",
};

async function checkPrStatus(prUrl: string): Promise<string | null> {
  if (!env.githubToken) return null;
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const [, owner, repo, number] = m;
  const headers = { Authorization: `Bearer ${env.githubToken}`, Accept: "application/vnd.github+json" };
  try {
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, { headers, signal: AbortSignal.timeout(3000) });
    if (!prRes.ok) return null;
    const pr = await prRes.json();
    const checksRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, { headers, signal: AbortSignal.timeout(3000) });
    if (!checksRes.ok) return null;
    const { check_runs } = await checksRes.json();
    if (!check_runs?.length) return null;
    const failed = check_runs.filter((c: any) => c.conclusion === "failure").length;
    const pending = check_runs.filter((c: any) => c.status !== "completed").length;
    if (failed > 0) return `${failed} check${failed > 1 ? "s" : ""} failing`;
    if (pending > 0) return "checks still running";
    return "all checks passing";
  } catch {
    return null;
  }
}

export async function toolProbeTask(ticketId: string): Promise<string> {
  const [job] = await sql`
    select status, question, pr_url, title from jobs where ticket_id = ${ticketId}
    order by finished_at desc nulls first, started_at desc nulls last limit 1
  `;
  if (!job) return `I don't have anything on ${ticketId} yet.`;
  const parts = [`${job.title} is ${STATUS_WORDS[job.status] ?? job.status}.`];
  if (job.status === "blocked" && job.question) parts.push(`Waiting on: ${job.question}`);
  if (job.pr_url) {
    const ci = await checkPrStatus(job.pr_url);
    if (ci) parts.push(`CI: ${ci}.`);
  }
  return parts.join(" ");
}

// this is the one answer that can genuinely cover "is my Mac connected" — nothing else in the
// router has a path for a system/connectivity question (it's not about any one ticket), so a
// caller re-asking that gets routed here by Jev's "overview" criteria and needs a real answer,
// not just task counts.
export async function toolGetStatusAll(): Promise<string> {
  // same transient-reconnect tolerance as the action-gating checks — this IS the answer to
  // "is my mac connected," so it needs to be at least as resilient as those, not less.
  const online = await runnerConnectedWithRetry();
  const jobs = await sql`select status from jobs where status in ('queued', 'running', 'blocked')`;
  const parts: string[] = [online ? "The runner on your Mac is connected." : "The runner on your Mac isn't connected right now."];
  if (jobs.length === 0) {
    parts.push("Nothing running right now.");
  } else {
    const running = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    const blocked = jobs.filter((j) => j.status === "blocked").length;
    const bits: string[] = [];
    if (running > 0) bits.push(`${running} running`);
    if (blocked > 0) bits.push(`${blocked} waiting on a decision from you`);
    parts.push(bits.join(", ") + ".");
  }
  return parts.join(" ");
}

export async function toolAnswerQuestion(answer: string): Promise<string> {
  if (!answer) return "I didn't catch an answer.";
  const blocked = await sql`select id, ticket_id, title, question from jobs where status = 'blocked' order by finished_at desc`;
  if (blocked.length === 0) return "There's nothing waiting on an answer right now.";

  let job = blocked[0];
  if (blocked.length > 1) {
    const candidates = blocked.map((b) => ({ id: b.ticket_id, title: b.question ?? b.title }));
    try {
      const { id, confidence } = await matchTicket(answer, candidates);
      if (!id || confidence < BAND.LOW) {
        const names = blocked.map((b) => `${b.ticket_id} — ${b.title}`).join(", or ");
        return `I have more than one open question — which ticket is this for: ${names}?`;
      }
      job = blocked.find((b) => b.ticket_id === id)!;
    } catch (err) {
      console.error("jev disambiguation failed", err);
      const names = blocked.map((b) => `${b.ticket_id} — ${b.title}`).join(", or ");
      return `I have more than one open question and can't tell which this is for right now — which ticket: ${names}?`;
    }
  }

  await sql`update jobs set answer = ${answer} where id = ${job.id}`;
  await dispatchAnswer(job.id, answer);
  broadcastStatus();
  return "Got it, I'll pass that along.";
}

export async function toolImplement(ticketArg: string): Promise<string> {
  const ticketId = ticketArg.trim();
  if (!ticketId) return "I didn't catch which ticket.";
  if (!(await runnerConnectedWithRetry())) return "The runner on your Mac isn't connected right now, so I can't start that.";

  const [job] = await sql`select id, title, pr_url from jobs where ticket_id = ${ticketId} and status = 'done' order by finished_at desc limit 1`;
  if (!job) return "I don't have a finished research pass for that ticket yet — order it first.";

  await sql`update jobs set status = 'queued' where id = ${job.id}`;
  dispatchImplement(job.id, { id: ticketId, title: job.title, description: "" });
  broadcastStatus();
  return `Starting the real implementation for ${job.title}. I'll call you when it's ready.`;
}

// one in-memory slot — single-user, one call at a time, no DB table needed. Delete is
// hard-gated behind an explicit second confirmation regardless of Jev's confidence: a
// destructive, voice-triggered action shouldn't go through on a single spoken "yes."
let pendingDelete: { ticketId: string; issueId: string; title: string; expiresAt: number } | null = null;
const AFFIRM_RE = /\b(yes|yeah|yep|yup|confirm(ed)?|do it|go ahead|sure|please do)\b/i;
const NEGATE_RE = /\b(no|don'?t|do not|nevermind|never mind|stop|cancel that)\b/i;

export async function toolHandleTask(request: string): Promise<string> {
  const text = (request ?? "").trim();
  if (!text) return "I didn't catch what you'd like me to do.";

  if (pendingDelete && pendingDelete.expiresAt > Date.now()) {
    if (NEGATE_RE.test(text)) {
      const title = pendingDelete.title;
      pendingDelete = null;
      return `Okay, leaving "${title}" as is.`;
    }
    if (AFFIRM_RE.test(text)) {
      const { issueId, title } = pendingDelete;
      pendingDelete = null;
      await archiveIssue(issueId);
      return `Done — "${title}" is archived. You can restore it from Linear's trash if you change your mind.`;
    }
  }
  pendingDelete = null; // any other utterance drops a stale pending delete rather than guessing

  const issues = await getCachedIssues();
  const candidates = issues.map((i) => ({ id: i.identifier, title: i.title }));

  let routed;
  try {
    // one Jev call, not two — intent + ticket match evaluated together, see router.ts.
    routed = await classifyAndMatch(text, candidates);
  } catch (err) {
    console.error("jev routing failed", err);
    return "Sorry, I'm having trouble understanding that right now — could you try again in a moment?";
  }
  const { intent, ticketId: id, ticketConfidence: confidence } = routed;

  switch (intent) {
    case "overview":
      // a confident ticket match alongside "overview" intent means Jev was sure *which*
      // ticket the caller meant but unsure of the verb — reproduced live: "is there
      // something related to X" landed as overview, which has no ticket-search path at all,
      // so a real match sat unused and the caller got a generic "nothing in progress" instead
      // of an actual answer about X. Prefer the specific answer when one was actually found.
      if (id && confidence >= BAND.LOW) return toolProbeTask(id);
      return toolGetStatusAll();

    case "create": {
      if (id && confidence >= BAND.LOW) {
        const existing = candidates.find((c) => c.id === id);
        return `That sounds like it might already be ${id} — "${existing?.title}". Want me to start that instead?`;
      }
      const title = text.length > 80 ? text.slice(0, 80) : text;
      const issue = await createIssue(title, text);
      invalidateIssueCache();
      return `Created ${issue.identifier} — "${issue.title}".`;
    }

    case "probe": {
      if (!id) return "I couldn't find a matching ticket to check on.";
      return toolProbeTask(id);
    }

    case "delete": {
      if (!id) return "I couldn't find a matching ticket to cancel.";
      const issue = await getIssueById(id);
      if (!issue) return "I couldn't find a matching ticket to cancel.";
      pendingDelete = { ticketId: id, issueId: issue.id, title: issue.title, expiresAt: Date.now() + 2 * 60 * 1000 };
      return `Just to confirm — cancel ${id}, "${issue.title}"? Say yes to archive it.`;
    }

    case "execute":
    default: {
      if (id && confidence >= BAND.LOW) return toolOrder(id);
      // journey 3, "unsure": no confident existing match — create then execute.
      if (!(await runnerConnectedWithRetry())) return "The runner on your Mac isn't connected right now, so I can't start that.";
      const title = text.length > 80 ? text.slice(0, 80) : text;
      const issue = await createIssue(title, text);
      invalidateIssueCache();
      return toolOrder(issue.identifier);
    }
  }
}
