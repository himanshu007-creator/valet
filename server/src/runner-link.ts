import type { WebSocket } from "ws";
import { sql } from "./db.ts";
import { triggerCallback } from "./bolna.ts";
import { env } from "./env.ts";
import { isCallActive } from "./call-guard.ts";
import { getIssueById, invalidateIssueCache } from "./cache.ts";
import { postComment, setIssueState, setIssueStateByName } from "./linear.ts";
import { broadcastStatus, dashboardClientCount } from "./dashboard-link.ts";
import { notifyPush } from "./push.ts";
import { liveBlockedJobs } from "./blocked.ts";

let runnerSocket: WebSocket | null = null;

// reproduced live: a job hit VALET_BLOCKED while the caller was genuinely still on an active
// call — the one-call-at-a-time guard correctly skipped a second, overlapping call, but then
// nothing ever re-attempted delivery once that call actually ended. Call this when a call ends;
// it checks for anything still waiting (undelivered terminal jobs, or any blocked job — blocked
// never gets a delivered_at, so it's always "still waiting" until answered) and places a fresh
// callback if so. That callback's first turn calls handle_task's overview like any other call,
// which is what actually marks things delivered — never optimistically marked here, so a call
// that itself goes unanswered just leaves the news to be retried, not silently lost.
// starts at "just fired", not 0 — reproduced live: a deploy resets this to 0, and the very next
// call-end webhook (which can legitimately be the user's own call landing right after a
// restart) triggered an immediate, undebounced catch-up call that overlapped with it. A fresh
// process waits out one full debounce window before its first catch-up attempt, like any other.
let lastCatchupAttempt = Date.now();
const CATCHUP_DEBOUNCE_MS = 2 * 60 * 1000;

export async function catchUpIfNeeded() {
  if (!env.allowedCallerNumber || isCallActive()) return;
  if (Date.now() - lastCatchupAttempt < CATCHUP_DEBOUNCE_MS) return;

  // reproduced live, twice: (1) the raw unfiltered count included stale 'blocked' rows for
  // tickets already marked Completed in Linear hours earlier — this is exactly the bug
  // liveBlockedJobs() was built to fix for every other path, just never wired in here. (2) a
  // genuinely still-blocked ticket kept re-triggering a fresh callback after every single call
  // that ended afterward, forever, saying nothing but "catching up" with zero real content —
  // surfaced_at (set below) stops a blocked item from generating more than one unprompted
  // callback; the caller can still always ask what's pending to hear it again.
  const [undelivered, blocked] = await Promise.all([
    sql`select id, ticket_id, title, status, pr_url, doc_url from jobs where status in ('done', 'failed', 'timeout') and delivered_at is null order by finished_at asc`,
    liveBlockedJobs().then((rows) => rows.filter((r) => !r.surfaced_at)),
  ]);
  if (undelivered.length === 0 && blocked.length === 0) return;

  lastCatchupAttempt = Date.now();
  const parts: string[] = [];
  for (const j of undelivered) {
    if (j.status === "done") parts.push(`${j.title} is ready${j.pr_url ? ` — PR: ${j.pr_url}` : j.doc_url ? `: ${j.doc_url}` : ""}.`);
    else parts.push(`${j.title} hit an error — want me to try it again?`);
  }
  for (const b of blocked) parts.push(`${b.title} needs a decision: ${b.question ?? "no question text recorded"}.`);
  const summary = parts.join(" ");

  if (undelivered.length > 0) await sql`update jobs set delivered_at = now() where id in ${sql(undelivered.map((j) => j.id))}`;
  if (blocked.length > 0) await sql`update jobs set surfaced_at = now() where id in ${sql(blocked.map((b) => b.id))}`;

  // same presence check as the terminal-job-finish path: one open dashboard tab already shows
  // this live, a call on top is pure noise.
  if (dashboardClientCount() === 1) {
    console.log("skipping catch-up callback — exactly one dashboard tab is open, already shown live");
    return;
  }

  console.log(`catching up: ${undelivered.length} undelivered, ${blocked.length} newly-surfaced blocked`);
  await triggerCallback(env.allowedCallerNumber, summary).catch((err) =>
    console.error("catch-up callback failed", err),
  );
}

// Render's proxy (and most reverse proxies) idle-time out a WebSocket with no data flowing —
// during a real phone call there can be long gaps with nothing to say to the runner, so without
// this the connection silently drops and reconnects every ~30-60s. A tool call landing in that
// reconnect gap sees "runner not connected" even though the Mac is right there. A ping keeps
// data flowing in both directions; the `ws` client auto-responds to pings with pongs. Tightened
// from 20s to 15s after a real mid-call drop outlasted the caller-side retry budget.
const PING_MS = 15_000;

export function setRunnerSocket(ws: WebSocket) {
  runnerSocket = ws;
  const connectedAt = Date.now();
  console.log("runner socket set");
  broadcastStatus(); // dashboard's "runner connected" indicator updates live, not just on job events
  const pinger = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, PING_MS);
  ws.on("close", (code, reason) => {
    clearInterval(pinger);
    if (runnerSocket === ws) {
      runnerSocket = null;
      // previously silent — reproduced a real "not connected mid-call" case with nothing in the
      // logs to show how long the gap actually was. Now there's a timestamped record on both
      // sides of every connect/disconnect pair.
      console.log(`runner socket closed after ${Math.round((Date.now() - connectedAt) / 1000)}s, code ${code} ${reason?.toString() ?? ""}`);
      broadcastStatus();
    }
  });
  ws.on("message", (raw) => handleRunnerMessage(String(raw)));
}

export function runnerConnected() {
  return runnerSocket !== null;
}

export function dispatchJob(jobId: string, ticket: { id: string; title: string; description: string }) {
  runnerSocket?.send(JSON.stringify({ type: "job", jobId, ticket }));
}

export function dispatchImplement(jobId: string, ticket: { id: string; title: string; description: string }) {
  runnerSocket?.send(JSON.stringify({ type: "implement", jobId, ticket }));
}

export async function dispatchAnswer(jobId: string, answer: string) {
  const [job] = await sql`select ticket_id from jobs where id = ${jobId}`;
  if (!job) return;
  runnerSocket?.send(JSON.stringify({ type: "answer", jobId, ticketId: job.ticket_id, answer }));
}

type RunnerStatusMsg = {
  type: "status";
  jobId: string;
  status: "running" | "done" | "blocked" | "failed" | "timeout";
  docPath?: string;
  docUrl?: string;
  prUrl?: string;
  question?: string;
  sessionId?: string;
  resumeCmd?: string;
  error?: string;
};

const TERMINAL = new Set(["done", "blocked", "failed", "timeout"]);

const STATUS_COMMENT: Record<string, (msg: RunnerStatusMsg) => string> = {
  done: (msg) => {
    const lines = ["VALET finished this ticket."];
    if (msg.prUrl) lines.push(`Draft PR: ${msg.prUrl}`);
    if (msg.docUrl) lines.push(`Notes: ${msg.docUrl}`);
    if (msg.resumeCmd) lines.push(`Resume the opencode session:\n\`\`\`\n${msg.resumeCmd}\n\`\`\``);
    return lines.join("\n\n");
  },
  blocked: (msg) => `VALET has a question on this ticket:\n\n${msg.question ?? "(no question text)"}`,
  failed: (msg) => `VALET hit an error on this ticket.${msg.error ? `\n\n\`\`\`\n${msg.error}\n\`\`\`` : ""}`,
  timeout: () => `VALET timed out researching this ticket (ran over 20 minutes with no result).`,
};

async function handleRunnerMessage(raw: string) {
  let msg: RunnerStatusMsg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type !== "status") return;

  const [before] = await sql`select status from jobs where id = ${msg.jobId}`;
  if (!before) return;
  // the runner's reconcile() re-reports an orphaned/already-terminal job on every reconnect —
  // without this guard, every repeat report fired a fresh Linear comment, push, and phone
  // callback for a job that had already been reported (reproduced live: a caller flapping
  // between connected/disconnected got called back repeatedly for nothing new). Only a real
  // status transition should have side effects; a report of the status it's already at is a
  // no-op past the DB write below.
  const alreadyReported = before.status === msg.status && TERMINAL.has(msg.status);

  const isTerminal = TERMINAL.has(msg.status);
  await sql`
    update jobs set
      status = ${msg.status},
      doc_path = coalesce(${msg.docPath ?? null}, doc_path),
      doc_url = coalesce(${msg.docUrl ?? null}, doc_url),
      pr_url = coalesce(${msg.prUrl ?? null}, pr_url),
      question = coalesce(${msg.question ?? null}, question),
      started_at = coalesce(started_at, case when ${msg.status} = 'running' then now() else null end),
      finished_at = case when ${isTerminal} then now() else finished_at end
    where id = ${msg.jobId}
  `;
  broadcastStatus();

  if (!isTerminal || alreadyReported) return;

  const [job] = await sql`select order_id, ticket_id from jobs where id = ${msg.jobId}`;
  if (!job) return;

  const issue = await getIssueById(job.ticket_id).catch(() => undefined);
  if (issue) {
    const body = STATUS_COMMENT[msg.status]?.(msg);
    if (body) await postComment(issue.id, body).catch((err) => console.error("linear comment failed", err));
    // Linear as the source of truth for state: done moves it to a completed-type column;
    // failed/timeout move it back to unstarted (not stuck "in progress" forever, and ready to
    // retry) — the duplicate-dispatch guard in toolOrder checks exactly this field. blocked moves
    // it to "Awaiting inputs" (a real, distinct, user-visible state — reproduced live: before
    // this it just sat in whatever started-type state it already had, indistinguishable from
    // genuinely still-running work). No explicit move back to started on resume needed: the next
    // terminal outcome (done/failed/timeout) already calls setIssueState above, which naturally
    // clears it out of Awaiting inputs.
    if (msg.status === "done") await setIssueState(issue.id, "completed").catch((err) => console.error("linear state update failed", err));
    else if (msg.status === "failed" || msg.status === "timeout") await setIssueState(issue.id, "unstarted").catch((err) => console.error("linear state update failed", err));
    else if (msg.status === "blocked") await setIssueStateByName(issue.id, "Awaiting inputs").catch((err) => console.error("linear state update failed", err));
    invalidateIssueCache(); // same stale-cache gap as toolOrder's guard — keep the next lookup honest
  }

  const siblings = await sql`select id, status, title, pr_url, doc_url, question from jobs where order_id = ${job.order_id}`;
  if (siblings.some((j) => !TERMINAL.has(j.status))) return; // order still has jobs in flight

  const done = siblings.filter((j) => j.status === "done");
  const blocked = siblings.filter((j) => j.status === "blocked");
  const errored = siblings.filter((j) => j.status === "failed" || j.status === "timeout");
  // reproduced live: this used to be just "N of M ready" — generic enough that a finished PR
  // and a finished research doc read identically, and neither ever said what to go look at. Say
  // what's actually there per job instead — this string drives both the push notification body
  // and the phone callback's spoken update (same two call sites below).
  const parts = done.map((j) => {
    if (j.pr_url) return `${j.title} is ready — PR: ${j.pr_url}`;
    if (j.doc_url) return `${j.title}'s notes are ready: ${j.doc_url}`;
    return `${j.title} is ready.`;
  });
  if (blocked.length > 0) parts.push(`${blocked.length} need a decision.`);
  if (errored.length > 0) parts.push(`${errored.length} hit an error — want me to try ${errored.length > 1 ? "them" : "it"} again?`);
  const summary = parts.join(" ");
  const question = blocked[0]?.question;

  await notifyPush("VALET", summary, job.ticket_id).catch((err) => console.error("push notify failed", err));

  // reproduced live: a job finishing mid-call triggered a second, overlapping outbound call —
  // push + the Linear comment above already cover it; one phone call at a time.
  // Exactly one open dashboard tab: a status change already appeared there instantly over the
  // live websocket — a phone call on top is pure noise. 0 tabs (nobody's looking) or 2+ (can't
  // tell who's actually looking at which device) both still call, same as always.
  if (dashboardClientCount() === 1) {
    console.log("skipping callback — exactly one dashboard tab is open, already shown live");
    // blocked jobs deliberately never get delivered_at (they need an actual answer, not just
    // "shown once") — only done/failed/timeout count as delivered by being seen live.
    const seenIds = siblings.filter((j) => j.status !== "blocked").map((j) => j.id);
    if (seenIds.length > 0) await sql`update jobs set delivered_at = now() where id in ${sql(seenIds)}`;
  } else if (env.allowedCallerNumber && !isCallActive()) {
    await triggerCallback(env.allowedCallerNumber, summary, question).catch((err) =>
      console.error("callback trigger failed", err),
    );
  } else if (env.allowedCallerNumber) {
    console.log("skipping callback — caller is already on a call");
  }
}
