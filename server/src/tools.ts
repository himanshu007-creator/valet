import { getPrioritiesSummary, getIssueById, getCachedIssues, invalidateIssueCache } from "./cache.ts";
import { sql } from "./db.ts";
import { runnerConnected, dispatchJob, dispatchAnswer, dispatchImplement } from "./runner-link.ts";
import { broadcastStatus } from "./dashboard-link.ts";
import { createIssue, archiveIssue, setIssueState } from "./linear.ts";
import { classifyAndMatch, matchTicket, BAND } from "./router.ts";
import { env } from "./env.ts";
import { timeGreeting } from "./greeting.ts";
import { liveBlockedJobs } from "./blocked.ts";

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

// a job can sit at status='blocked' forever if the ticket gets resolved another way — marked
// done/cancelled directly in Linear, or any path other than actually answering the question —
// nothing before this ever cleared the DB row to match. Reproduced live: VALET kept re-asking
// about HIM-11 and HIM-12 long after both were marked Completed directly in Linear. Linear is
// the real source of truth for "is this still open" — check it live on every read instead of
// trusting the DB's own stale status column.
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

  // Linear is the source of truth for "already being worked on" — a ticket Linear already
  // shows in a started-type state (In Progress or similar) doesn't get a second, duplicate job
  // dispatched for it just because another call/request asked to start it again.
  const alreadyStarted = found.filter((i) => i!.state?.type === "started");
  const toStart = found.filter((i) => i!.state?.type !== "started");

  if (toStart.length === 0) {
    const names = alreadyStarted.map((i) => i!.identifier).join(", ");
    return `${names} ${alreadyStarted.length > 1 ? "are" : "is"} already being worked on — I'll let you know when done, no need to start it again.`;
  }

  const [order] = await sql`insert into orders (tickets) values (${toStart.map((i) => i!.identifier)}) returning id`;
  for (const issue of toStart) {
    const [job] = await sql`
      insert into jobs (order_id, ticket_id, title, status, ticket_url, description)
      values (${order.id}, ${issue!.identifier}, ${issue!.title}, 'queued', ${issue!.url}, ${issue!.description ?? null})
      returning id
    `;
    dispatchJob(job.id, { id: issue!.identifier, title: issue!.title, description: issue!.description ?? "" });
    await setIssueState(issue!.id, "started").catch((err) => console.error("linear state update failed", err));
  }
  // reproduced live: the duplicate-dispatch guard above reads from this same cache — without
  // invalidating here, a second "start it" within the 5-minute TTL still saw the pre-update
  // (Backlog) state and dispatched a genuine duplicate job instead of being blocked.
  invalidateIssueCache();
  broadcastStatus();
  const parts = [`Starting on ${toStart.length} thing${toStart.length > 1 ? "s" : ""}. I'll call you when they're done.`];
  if (alreadyStarted.length > 0) {
    parts.push(`${alreadyStarted.map((i) => i!.identifier).join(", ")} ${alreadyStarted.length > 1 ? "were" : "was"} already in progress, so I skipped ${alreadyStarted.length > 1 ? "those" : "that"}.`);
  }
  return parts.join(" ");
}

// full phrases, not words to fill into a fixed "X is ___" template — "X is hit an error" is
// broken English, reproduced live via toolProbeTask's old STATUS_WORDS[status] lookup.
const STATUS_PHRASE: Record<string, (title: string) => string> = {
  queued: (t) => `${t} is queued`,
  running: (t) => `${t} is in progress`,
  done: (t) => `${t} is done`,
  blocked: (t) => `${t} is waiting on a decision from you`,
  failed: (t) => `${t} hit an error`,
  timeout: (t) => `${t} timed out`,
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
  if (!job) {
    // reproduced live: a ticket created minutes before the call, never dispatched — only the
    // jobs table was checked, which has nothing until a ticket is actually started. "I don't
    // have anything on this yet" made a real ticket with a full description sound like it
    // didn't exist. Fall back to the actual Linear content before giving up.
    const issue = await getIssueById(ticketId);
    if (!issue) return `I couldn't find a ticket called ${ticketId}.`;
    const desc = issue.description?.trim();
    return `${issue.title}.${desc ? ` ${desc}` : ""} It hasn't been started yet — want me to start it?`;
  }
  const phrase = STATUS_PHRASE[job.status] ?? ((t: string) => `${t} is ${job.status}`);
  const parts = [`${phrase(job.title)}.`];
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
  const [activeJobs, blocked] = await Promise.all([
    sql`select status, title from jobs where status in ('queued', 'running')`,
    liveBlockedJobs(),
  ]);
  // covers inbound calls: the welcome message can't know the real time (no per-call data for
  // inbound), but this overview always runs on an inbound call's first turn — this is the
  // actual first thing a caller who rings in hears, so it's where their time-of-day greeting
  // lands for that direction.
  const parts: string[] = [`${timeGreeting()}!`, online ? "The runner on your Mac is connected." : "The runner on your Mac isn't connected right now."];
  if (activeJobs.length === 0 && blocked.length === 0) {
    parts.push("Nothing running right now.");
  } else {
    const running = activeJobs.length;
    const bits: string[] = [];
    if (running > 0) bits.push(`${running} running`);
    if (blocked.length > 0) bits.push(`${blocked.length} waiting on a decision from you`);
    parts.push(bits.join(", ") + ".");
    // a blocked count alone forces the caller to ask "what's the question" as a second
    // round-trip — just say it, same spell-out-vs-summarize rule as undelivered terminal jobs.
    // Past that, offer to go through them rather than silently withholding the questions —
    // reproduced live: a caller who heard just "four waiting on a decision" said "let's continue
    // for pending decisions" next, which had nowhere to go (see WANTS_PENDING_LIST below).
    const SPELL_OUT = 3;
    if (blocked.length > 0 && blocked.length <= SPELL_OUT) {
      for (const j of blocked) if (j.question) parts.push(`On ${j.title}: ${j.question}`);
    } else if (blocked.length > SPELL_OUT) {
      parts.push("Want me to go through them?");
    }
  }

  // a caller who phones in fresh — not via a callback — must still hear about anything that
  // finished or failed while they were away, no matter how many orders ago. Not scoped to the
  // latest order: every undelivered terminal job, across all of them.
  const undelivered = await sql`
    select id, ticket_id, title, status, pr_url from jobs
    where status in ('done', 'failed', 'timeout') and delivered_at is null
    order by finished_at asc
  `;
  if (undelivered.length > 0) {
    const done = undelivered.filter((j) => j.status === "done");
    const errored = undelivered.filter((j) => j.status !== "done");
    const SPELL_OUT = 3; // beyond this, a flat list gets unwieldy to listen to — summarize and offer detail
    if (undelivered.length <= SPELL_OUT) {
      for (const j of done) parts.push(`${j.title} is done${j.pr_url ? ", PR's ready" : ""}.`);
      for (const j of errored) parts.push(`${j.title} hit an error.`);
    } else {
      const bits: string[] = [];
      if (done.length > 0) bits.push(`${done.length} finished`);
      if (errored.length > 0) bits.push(`${errored.length} hit an error`);
      parts.push(`Since we last spoke, ${bits.join(" and ")}. Want me to go through them, or just the highlights?`);
    }
    await sql`update jobs set delivered_at = now() where id in ${sql(undelivered.map((j) => j.id))}`;
  }

  return parts.join(" ");
}

export async function toolAnswerQuestion(answer: string): Promise<string> {
  if (!answer) return "I didn't catch an answer.";
  const blocked = await liveBlockedJobs();
  if (blocked.length === 0) return "There's nothing waiting on an answer right now.";

  let job = blocked[0];
  if (blocked.length > 1) {
    // reproduced live: candidates used only the blocked question's text ("the repo lacks a
    // changelog...") with no mention of the ticket's actual topic — a caller naturally saying
    // "the featbit one" had nothing to match against and got the same disambiguation question
    // asked right back at them. Include the ticket title so either phrasing matches.
    const candidates = blocked.map((b) => ({ id: b.ticket_id, title: `${b.title} — ${b.question ?? ""}` }));
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
// a low-confidence "create" guess shouldn't silently clutter Linear with ASR noise — reproduced
// live: a garbled fragment ("system task to feed with") at 0.60 intent confidence got created
// as a real ticket before the caller could stop it. Same one-slot confirm pattern as delete,
// just not hard-gated regardless of confidence the way delete is — a clear, high-confidence
// "create a ticket for X" still goes straight through, no added friction for the common case.
let pendingCreate: { title: string; description: string; expiresAt: number } | null = null;
const CREATE_CONFIDENCE_THRESHOLD = 0.7;
const AFFIRM_RE = /\b(yes|yeah|yep|yup|confirm(ed)?|do it|go ahead|sure|please do)\b/i;
const NEGATE_RE = /\b(no|don'?t|do not|nevermind|never mind|stop|cancel that)\b/i;

// reproduced live: "update the status to running" has no real destination today — Jev has no
// better bucket than "execute" for it, which dispatches an entire new research job instead of
// just relabeling the ticket. This is the real destination: plain keyword match on a small,
// known vocabulary, not another Jev round trip.
const STATUS_WORD: { re: RegExp; type: "started" | "unstarted" | "completed"; label: string }[] = [
  { re: /\b(done|complete(d)?|finish(ed)?|closed? out)\b/i, type: "completed", label: "done" },
  { re: /\b(in progress|running|started|working on)\b/i, type: "started", label: "in progress" },
  { re: /\b(todo|to do|backlog|not started|reopen(ed)?|open)\b/i, type: "unstarted", label: "todo" },
];

function parseStatusWord(text: string): { type: "started" | "unstarted" | "completed"; label: string } | null {
  for (const w of STATUS_WORD) if (w.re.test(text)) return { type: w.type, label: w.label };
  return null;
}

// reproduced live: "let's continue for pending decisions" (following an overview that said
// "4 waiting on a decision, want me to go through them?") had no real destination — Jev's
// router has no ticket name to match on a phrase like this, so it either misfired into
// "overview" again (same unhelpful answer, no progress) or "execute"/"create" (a phantom ticket
// from the words "let's continue for pending decision"). This is deterministic on purpose: no
// ticket name needed, just list what's actually blocked.
const WANTS_PENDING_LIST = /\b(go(ing)? through|continue (with|for|on)?|what (are|were) the)\b.*\b(pending|blocked|open|those|them)\b|\b(pending|blocked|open) (decision|question|task)s?\b/i;

async function listBlockedQuestions(): Promise<string> {
  const blocked = await liveBlockedJobs();
  if (blocked.length === 0) return "There's nothing waiting on a decision right now.";
  return blocked.map((b) => `On ${b.title}: ${b.question ?? "no question text recorded"}.`).join(" ");
}

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

  if (pendingCreate && pendingCreate.expiresAt > Date.now()) {
    if (NEGATE_RE.test(text)) {
      pendingCreate = null;
      return "Okay, not creating that.";
    }
    if (AFFIRM_RE.test(text)) {
      const { title, description } = pendingCreate;
      pendingCreate = null;
      const issue = await createIssue(title, description);
      invalidateIssueCache();
      return `Created ${issue.identifier} — "${issue.title}".`;
    }
  }
  pendingCreate = null;

  if (WANTS_PENDING_LIST.test(text)) return listBlockedQuestions();

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
  const { intent, intentConfidence, ticketId: id, ticketConfidence: confidence } = routed;

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
      if (intentConfidence < CREATE_CONFIDENCE_THRESHOLD) {
        pendingCreate = { title, description: text, expiresAt: Date.now() + 2 * 60 * 1000 };
        return `Want me to create a new ticket for "${title}"? Say yes to confirm.`;
      }
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

    case "update_status": {
      if (!id) return "I couldn't find a matching ticket to update.";
      const target = parseStatusWord(text);
      if (!target) return "What status would you like me to set it to — done, in progress, or back to the backlog?";
      const issue = await getIssueById(id);
      if (!issue) return "I couldn't find a matching ticket to update.";
      await setIssueState(issue.id, target.type);
      invalidateIssueCache();
      return `Done — marked ${id} as ${target.label}.`;
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
