import type { WebSocket } from "ws";
import { sql } from "./db.ts";
import { triggerCallback } from "./bolna.ts";
import { env } from "./env.ts";
import { getIssueById } from "./cache.ts";
import { postComment } from "./linear.ts";
import { broadcastStatus } from "./dashboard-link.ts";
import { notifyPush } from "./push.ts";

let runnerSocket: WebSocket | null = null;

export function setRunnerSocket(ws: WebSocket) {
  runnerSocket = ws;
  ws.on("close", () => {
    if (runnerSocket === ws) runnerSocket = null;
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

  const isTerminal = TERMINAL.has(msg.status);
  await sql`
    update jobs set
      status = ${msg.status},
      doc_path = coalesce(${msg.docPath ?? null}, doc_path),
      pr_url = coalesce(${msg.prUrl ?? null}, pr_url),
      question = coalesce(${msg.question ?? null}, question),
      started_at = coalesce(started_at, case when ${msg.status} = 'running' then now() else null end),
      finished_at = case when ${isTerminal} then now() else finished_at end
    where id = ${msg.jobId}
  `;
  broadcastStatus();

  if (!isTerminal) return;

  const [job] = await sql`select order_id, ticket_id from jobs where id = ${msg.jobId}`;
  if (!job) return;

  const issue = await getIssueById(job.ticket_id).catch(() => undefined);
  if (issue) {
    const body = STATUS_COMMENT[msg.status]?.(msg);
    if (body) await postComment(issue.id, body).catch((err) => console.error("linear comment failed", err));
  }

  const siblings = await sql`select status, title, pr_url, question from jobs where order_id = ${job.order_id}`;
  if (siblings.some((j) => !TERMINAL.has(j.status))) return; // order still has jobs in flight

  const done = siblings.filter((j) => j.status === "done");
  const blocked = siblings.filter((j) => j.status === "blocked");
  const errored = siblings.filter((j) => j.status === "failed" || j.status === "timeout");
  const parts = [`${done.length} of ${siblings.length} ready.`];
  if (blocked.length > 0) parts.push(`${blocked.length} need a decision.`);
  if (errored.length > 0) parts.push(`${errored.length} hit an error.`);
  const summary = parts.join(" ");
  const question = blocked[0]?.question;

  await notifyPush("VALET", summary, job.ticket_id).catch((err) => console.error("push notify failed", err));

  if (env.allowedCallerNumber) {
    await triggerCallback(env.allowedCallerNumber, summary, question).catch((err) =>
      console.error("callback trigger failed", err),
    );
  }
}
